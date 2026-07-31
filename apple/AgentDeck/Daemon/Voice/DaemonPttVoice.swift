#if os(macOS)
// DaemonPttVoice.swift — host push-to-talk for deck surfaces
//
// A Stream Deck / D200H key contributes only a button; the host contributes
// the microphone, the on-device recognizer and the speakers. Begin/end are
// explicit client commands bound to a target session — no wake word and no
// VAD auto-stop, which is why this is a sibling of DaemonVoiceAssistant
// rather than a mode of it: the assistant's silence-driven state machine
// would cut a held key short while the user pauses to think.
//
// Everything here is first-party framework API (AVFoundation + Speech), so
// the App Store build carries the feature — this is the Swift-daemon parity
// for the Node daemon's `voice` command (bridge/src/daemon-server.ts
// handleHostVoicePtt). All state is @MainActor: AVFoundation callbacks and
// the daemon's @DaemonActor callers both hop here explicitly.

import Foundation
import AVFoundation
import Speech

@MainActor
final class DaemonPttVoice {
    private var engine: AVAudioEngine?
    private var file: AVAudioFile?
    private var url: URL?
    private var maxTimer: Task<Void, Never>?
    private let synthesizer = AVSpeechSynthesizer()
    /// One PTT hold tops out well below this; the cap only bounds a lost
    /// key-up (client crash mid-hold).
    private let maxDuration: TimeInterval = 30

    var isRecording: Bool { engine != nil }

    /// Fired when maxDuration elapses with the key still held — the owner
    /// runs the same path as an explicit stop so the utterance is not lost.
    var onAutoStop: (() -> Void)?

    /// Start capturing. Returns nil on success, or a short stable error code
    /// ("mic_unauthorized" / "no_input" / "record_failed") the daemon can put
    /// on a voice_state error event.
    func begin() -> String? {
        guard engine == nil else { return "busy" }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            return "mic_unauthorized"
        default:
            return "mic_unauthorized"
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in }
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return "no_input" }

        // Record at the input's native format — SFSpeechURLRecognitionRequest
        // reads any PCM rate, so there is no reason to resample here (and a
        // file whose processing format differs from the tap's would make
        // every write throw).
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-ptt-\(UUID().uuidString).caf")
        do {
            file = try AVAudioFile(forWriting: url, settings: format.settings)
        } catch {
            DaemonLogger.shared.error("PTT: audio file create failed: \(error)")
            return "record_failed"
        }
        self.url = url

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            // The tap runs on a realtime audio queue; hop to the actor that
            // owns `file` instead of writing from the callback thread.
            Task { @MainActor in
                guard let self, self.engine != nil else { return }
                do { try self.file?.write(from: buffer) } catch {
                    DaemonLogger.shared.debug("Voice", "PTT buffer write failed: \(error.localizedDescription)")
                }
            }
        }

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            cleanupFile()
            DaemonLogger.shared.error("PTT: engine start failed: \(error)")
            return "record_failed"
        }
        self.engine = engine

        maxTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            guard let self, self.isRecording else { return }
            self.onAutoStop?()
        }
        _ = maxDuration // documented cap; the sleep above is its one use site
        DaemonLogger.shared.debug("Voice", "PTT recording started")
        return nil
    }

    /// Stop and transcribe. Returns the recognized text, or nil when the
    /// capture was empty / unrecognizable (caller reports "no_speech").
    func end(preferredLocales: [Locale]) async -> String? {
        stopEngine()
        guard let url else { return nil }
        defer { cleanupFile() }
        let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
        guard size > 4096 else {
            DaemonLogger.shared.debug("Voice", "PTT capture too small (\(size)B)")
            return nil
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            DaemonLogger.shared.debug("Voice", "PTT: speech recognition not authorized")
            return nil
        }
        return await VoiceSpeechTranscriber.transcribe(url: url, preferredLocales: preferredLocales)
    }

    func cancel() {
        stopEngine()
        cleanupFile()
        DaemonLogger.shared.debug("Voice", "PTT recording cancelled")
    }

    /// Speak a session's reply through the host speakers. Unlike the voice
    /// assistant's `speak`, this has no state-machine guard — the arming in
    /// DaemonServer already decided this reply is wanted.
    func speakReply(_ text: String) {
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
            ?? AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    private func stopEngine() {
        maxTimer?.cancel()
        maxTimer = nil
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        self.file = nil
    }

    private func cleanupFile() {
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        file = nil
    }
}
#endif
