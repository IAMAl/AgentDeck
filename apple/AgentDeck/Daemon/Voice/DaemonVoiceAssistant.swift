#if os(macOS)
// DaemonVoiceAssistant.swift — Voice assistant pipeline
//
// Pipeline: AVAudioEngine capture → SFSpeechRecognizer on-device transcription
// → agent prompt → AVSpeechSynthesizer TTS response. All first-party Apple
// frameworks; no bundled whisper runtime, no whisper.cpp server dependency,
// no subprocess spawn. This keeps the App Store build zero-setup for voice
// input and removes the cross-build `#if AGENTDECK_APP_STORE` guards the
// whisper-CLI fallback used to require.

import Foundation
import AVFoundation
import Speech

/// Voice assistant: record → transcribe → send to agent → TTS response
@MainActor
final class DaemonVoiceAssistant {
    enum State: String, Sendable {
        case idle, listening, processing, speaking, disabled
    }

    private(set) var state: State = .idle
    private var audioEngine: AVAudioEngine?
    private var audioFile: AVAudioFile?
    private var recordingURL: URL?
    private let synthesizer = AVSpeechSynthesizer()

    // Callbacks
    var onStateChanged: ((State, String?, String?) -> Void)?  // (state, text, responseText)
    var onTranscription: ((String) -> Void)?
    var sendPrompt: ((String) -> Void)?
    var onWakeWordDetected: ((String, TimeInterval) -> Void)?  // (deviceId, timestamp)

    // Config
    private let maxRecordingDuration: TimeInterval = 15
    private let silenceTimeout: TimeInterval = 1.5
    private let silenceThreshold: Float = 0.01
    private var recordingTimer: Task<Void, Never>?
    private var silenceTimer: Task<Void, Never>?
    private var lastSoundTime: Date = .now

    // MARK: - Lifecycle

    func start() -> Bool {
        // Check microphone permission
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            VoicePermissionRequester.requestMicrophoneAccess()
            return false
        default:
            state = .disabled
            onStateChanged?(.disabled, nil, nil)
            return false
        }

        // Request speech recognition auth up front. The first call triggers a
        // system TCC prompt backed by `NSSpeechRecognitionUsageDescription` in
        // Info.plist; subsequent calls hit the cached decision. We don't block
        // voice assistant readiness on this — the user can still record, and
        // `transcribe()` reports a helpful failure if the auth ends up denied.
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            VoicePermissionRequester.requestSpeechRecognitionAuthorization()
        }

        state = .idle
        DaemonLogger.shared.info("Voice assistant ready")
        return true
    }

    func stop() {
        stopRecording()
        state = .idle
    }

    // MARK: - Recording

    func startRecording() {
        guard state == .idle else { return }
        state = .listening
        onStateChanged?(.listening, nil, nil)

        let engine = AVAudioEngine()
        self.audioEngine = engine

        let tempDir = FileManager.default.temporaryDirectory
        let url = tempDir.appendingPathComponent("agentdeck-voice-\(UUID().uuidString).wav")
        self.recordingURL = url

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        do {
            audioFile = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
            ])
        } catch {
            DaemonLogger.shared.error("Failed to create audio file: \(error)")
            state = .idle
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            Task { @MainActor in
                self?.processAudioBuffer(buffer)
            }
        }

        do {
            try engine.start()
            lastSoundTime = .now
            DaemonLogger.shared.debug("Voice", "Recording started")
        } catch {
            DaemonLogger.shared.error("Failed to start audio engine: \(error)")
            state = .idle
            return
        }

        // Max recording timer
        recordingTimer = Task {
            try? await Task.sleep(for: .seconds(maxRecordingDuration))
            guard !Task.isCancelled else { return }
            self.stopRecording()
            self.transcribe()
        }
    }

    func stopRecording() {
        recordingTimer?.cancel()
        silenceTimer?.cancel()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        audioFile = nil
    }

    func cancelRecording() {
        stopRecording()
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
        state = .idle
        onStateChanged?(.idle, nil, nil)
    }

    // MARK: - Audio Processing

    private func processAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        // Write to file
        try? audioFile?.write(from: buffer)

        // RMS silence detection
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<frameCount { sum += channelData[i] * channelData[i] }
        let rms = sqrt(sum / Float(frameCount))

        if rms > silenceThreshold {
            lastSoundTime = .now
            silenceTimer?.cancel()
        } else if Date().timeIntervalSince(lastSoundTime) > silenceTimeout && state == .listening {
            // Silence detected — stop and transcribe
            silenceTimer?.cancel()
            silenceTimer = Task {
                self.stopRecording()
                self.transcribe()
            }
        }
    }

    // MARK: - Transcription

    private func transcribe() {
        guard let url = recordingURL else { return }
        state = .processing
        onStateChanged?(.processing, nil, nil)

        Task {
            // Check file size (skip if silence only)
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = attrs?[.size] as? Int ?? 0
            if size < 1000 {
                DaemonLogger.shared.debug("Voice", "Recording too small (\(size)B), likely silence")
                self.cancelRecording()
                return
            }

            let text = await transcribe(url)

            // Cleanup recording
            try? FileManager.default.removeItem(at: url)
            recordingURL = nil

            guard let text, !text.isEmpty else {
                state = .idle
                onStateChanged?(.idle, nil, nil)
                return
            }

            DaemonLogger.shared.debug("Voice", "Transcribed: \(text)")
            onStateChanged?(.processing, text, nil)
            onTranscription?(text)

            // Send to agent
            sendPrompt?(text)
        }
    }

    /// Transcribe a recorded WAV via Apple's `SFSpeechRecognizer`. On-device
    /// mode is requested so the recording never leaves the machine — matches
    /// the old whisper-server + whisper-cli privacy guarantee and removes the
    /// "whisper.cpp setup" user burden.
    ///
    /// Failure modes:
    /// - Permission denied → returns nil. Caller shows "speech recognition
    ///   not authorized" UI; user re-grants in System Settings.
    /// - Recognizer unavailable (OS hasn't finished its dictation model
    ///   download) → returns nil. Retry after a short delay usually works.
    /// - Empty audio → returns nil (trimmed recording is < silenceThreshold).
    private func transcribe(_ url: URL) async -> String? {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            DaemonLogger.shared.debug("Voice", "Speech recognition not authorized")
            return nil
        }
        return await VoiceSpeechTranscriber.transcribe(
            url: url,
            preferredLocales: [Locale.current, Locale(identifier: "en_US")]
        )
    }

    // MARK: - TTS

    func speak(_ text: String) {
        state = .speaking
        onStateChanged?(.speaking, nil, text)

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "ko-KR") ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        synthesizer.speak(utterance)

        // Monitor completion
        Task {
            while synthesizer.isSpeaking {
                try? await Task.sleep(for: .milliseconds(200))
            }
            state = .idle
            onStateChanged?(.idle, nil, nil)
        }
    }

    /// Reset response timeout — called when agent activity detected during voice processing
    /// to prevent premature timeout while the agent is still working.
    func resetResponseTimeout() {
        // Currently a no-op stub; response timeout tracking will be added
        // when the full voice pipeline is wired end-to-end.
        DaemonLogger.shared.debug("Voice", "Response timeout reset (agent still processing)")
    }

    /// Handle agent response — TTS if voice assistant initiated the prompt
    func handleResponse(_ text: String) {
        guard state == .processing else { return }
        speak(text.isEmpty ? "완료했습니다." : String(text.prefix(200)))
    }
}

/// TCC and Speech callbacks are invoked by Apple frameworks on arbitrary
/// dispatch queues. Keep the callback literals outside the `@MainActor`
/// `DaemonVoiceAssistant` type; otherwise Swift 6's executor check can trap
/// when a framework calls an actor-isolated closure on a background queue.
private enum VoicePermissionRequester {
    static func requestMicrophoneAccess() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
    }

    static func requestSpeechRecognitionAuthorization() {
        SFSpeechRecognizer.requestAuthorization { status in
            DaemonLogger.shared.debug("Voice", "Speech authorization status=\(status.rawValue)")
        }
    }
}

enum VoiceSpeechTranscriber {
    static func transcribe(url: URL, preferredLocales: [Locale]) async -> String? {
        guard let recognizer = makeSpeechRecognizer(preferredLocales: preferredLocales),
              recognizer.isAvailable else {
            DaemonLogger.shared.debug("Voice", "Speech recognizer unavailable — on-device model may still be downloading")
            return nil
        }

        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        // On-device keeps audio local — critical because the captured WAV
        // frequently contains project/code names the user wouldn't want
        // routed to Apple's speech servers. macOS 13+ / iOS 13+ support
        // `requiresOnDeviceRecognition`; older OS falls back to the default.
        if #available(macOS 13.0, iOS 13.0, *) {
            request.requiresOnDeviceRecognition = true
        }
        // `dictation` task hint tells the engine we expect natural-language
        // prose rather than short keyword commands — better fit for prompts
        // like "run the tests in the auth module".
        request.taskHint = .dictation

        return await withCheckedContinuation { continuation in
            let resumeBox = VoiceSpeechContinuation(continuation)

            _ = recognizer.recognitionTask(with: request) { result, error in
                if let error {
                    DaemonLogger.shared.debug("Voice", "SFSpeech error: \(error.localizedDescription)")
                    resumeBox.resume(nil)
                    return
                }
                guard let result, result.isFinal else { return }
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                resumeBox.resume(text.isEmpty ? nil : text)
            }
        }
    }

    private static func makeSpeechRecognizer(preferredLocales: [Locale]) -> SFSpeechRecognizer? {
        for locale in preferredLocales {
            if let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable {
                return recognizer
            }
        }
        return SFSpeechRecognizer()
    }
}

private final class VoiceSpeechContinuation: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false
    private let continuation: CheckedContinuation<String?, Never>

    init(_ continuation: CheckedContinuation<String?, Never>) {
        self.continuation = continuation
    }

    func resume(_ text: String?) {
        lock.lock()
        defer { lock.unlock() }
        guard !didResume else { return }
        didResume = true
        continuation.resume(returning: text)
    }
}
#endif
