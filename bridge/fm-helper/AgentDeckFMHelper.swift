import Foundation
import AVFoundation
import Speech
#if canImport(FoundationModels)
import FoundationModels
#endif

struct HelperRequest: Decodable {
    let id: Int
    let type: String?
    let prompt: String?
    let instructions: String?
    let temperature: Double?
    /// `transcribe`: absolute path to a WAV file the daemon already wrote.
    let wav: String?
    /// BCP-47 locale hint, e.g. "ko-KR". Falls back to the current locale then en-US.
    let locale: String?
    /// `speak`: text to synthesize, with optional voice/rate overrides.
    let text: String?
    let voice: String?
    let rate: Double?
}

@main
struct AgentDeckFMHelper {
    static func main() async {
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                await handle(line)
            }
        } catch {
            write(["id": -1, "error": "stdin_error", "reason": String(describing: error)])
        }
    }

    private static func handle(_ line: String) async {
        guard let data = line.data(using: .utf8),
              let request = try? JSONDecoder().decode(HelperRequest.self, from: data) else {
            write(["id": -1, "error": "bad_request", "reason": "invalid JSON line"])
            return
        }

        if request.type == "health" {
            write(healthResponse(id: request.id))
            return
        }

        if request.type == "transcribe" {
            await handleTranscribe(request)
            return
        }

        if request.type == "speak" {
            await handleSpeak(request)
            return
        }

        if request.type == "synthesize" {
            await handleSynthesize(request)
            return
        }

        guard let prompt = request.prompt, !prompt.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing prompt"])
            return
        }

#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                write([
                    "id": request.id,
                    "error": "unavailable",
                    "reason": unavailableReason(),
                ])
                return
            }

            do {
                let session = LanguageModelSession(
                    instructions: request.instructions ?? "You are an exacting code evaluator. Reply with strict JSON only."
                )
                let options = GenerationOptions(temperature: request.temperature ?? 0)
                let response = try await session.respond(to: prompt, options: options)
                write(["id": request.id, "text": response.content])
            } catch {
                write(["id": request.id, "error": "session_error", "reason": String(describing: error)])
            }
        } else {
            write(["id": request.id, "error": "unavailable", "reason": "macOS 26 or later required"])
        }
#else
        write(["id": request.id, "error": "unavailable", "reason": "FoundationModels framework not present"])
#endif
    }

    // MARK: - Speech to text

    /// On-device transcription of a WAV the daemon already captured (from the
    /// host mic or streamed off a board). `requiresOnDeviceRecognition` keeps
    /// audio local — the captured speech routinely contains project and code
    /// names that must not reach Apple's servers. Mirrors the Swift daemon's
    /// `VoiceSpeechTranscriber` so both daemons transcribe identically.
    private static func handleTranscribe(_ request: HelperRequest) async {
        guard let path = request.wav, !path.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing wav path"])
            return
        }
        guard FileManager.default.fileExists(atPath: path) else {
            write(["id": request.id, "error": "bad_request", "reason": "wav not found: \(path)"])
            return
        }

        let status = await ensureSpeechAuthorization()
        guard status == .authorized else {
            write([
                "id": request.id,
                "error": "unauthorized",
                "reason": "speech recognition not authorized (\(status.rawValue)) — grant it in System Settings › Privacy & Security › Speech Recognition",
            ])
            return
        }

        var locales: [Locale] = []
        if let tag = request.locale, !tag.isEmpty { locales.append(Locale(identifier: tag)) }
        locales.append(Locale.current)
        locales.append(Locale(identifier: "en-US"))

        guard let recognizer = locales.lazy.compactMap({ SFSpeechRecognizer(locale: $0) }).first(where: { $0.isAvailable }) else {
            write([
                "id": request.id,
                "error": "unavailable",
                "reason": "no available on-device recognizer — the dictation model may still be downloading",
            ])
            return
        }

        let speechRequest = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
        speechRequest.shouldReportPartialResults = false
        speechRequest.requiresOnDeviceRecognition = true
        speechRequest.taskHint = .dictation

        let result: [String: Any] = await withCheckedContinuation { continuation in
            let box = ResumeOnce(continuation)
            _ = recognizer.recognitionTask(with: speechRequest) { result, error in
                if let error {
                    box.resume(["id": request.id, "error": "speech_error", "reason": String(describing: error)])
                    return
                }
                guard let result, result.isFinal else { return }
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                box.resume(["id": request.id, "text": text])
            }
        }
        write(result)
    }

    private static func ensureSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            let box = ResumeOnce(continuation)
            SFSpeechRecognizer.requestAuthorization { box.resume($0) }
        }
    }

    // MARK: - Text to speech

    /// Speak a reply through the host's audio output. Kept in the same helper
    /// so the voice round trip needs exactly one bundled binary.
    private static func handleSpeak(_ request: HelperRequest) async {
        guard let text = request.text, !text.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing text"])
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        if let voiceId = request.voice, let v = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = v
        } else if let tag = request.locale, let v = AVSpeechSynthesisVoice(language: tag) {
            utterance.voice = v
        }
        if let rate = request.rate { utterance.rate = Float(rate) }

        let synthesizer = AVSpeechSynthesizer()
        let delegate = SpeakDelegate()
        synthesizer.delegate = delegate
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            delegate.onFinish = ResumeOnce(continuation)
            synthesizer.speak(utterance)
        }
        write(["id": request.id, "spoken": true])
    }

    /// Synthesize to a WAV file instead of the host's speakers, so the daemon
    /// can stream the audio somewhere else — a battery-powered board holding
    /// the only speaker the user is near. Fixed at 16 kHz mono PCM16: that is
    /// what the boards' I2S amplifiers are configured for and what keeps a
    /// spoken reply inside a WiFi budget an ESP32 can actually drain.
    private static func handleSynthesize(_ request: HelperRequest) async {
        guard let text = request.text, !text.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing text"])
            return
        }
        guard let outPath = request.wav, !outPath.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing wav output path"])
            return
        }
        let sampleRate = 16000.0
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: sampleRate,
                                            channels: 1,
                                            interleaved: true) else {
            write(["id": request.id, "error": "synthesis_failed", "reason": "output format unavailable"])
            return
        }

        let utterance = AVSpeechUtterance(string: text)
        if let voiceId = request.voice, let v = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = v
        } else if let tag = request.locale, let v = AVSpeechSynthesisVoice(language: tag) {
            utterance.voice = v
        }
        if let rate = request.rate { utterance.rate = Float(rate) }

        // The write callback is not documented to run on any particular queue,
        // and it appends to shared state, so the accumulator owns a lock.
        let sink = PCMSink()
        let synthesizer = AVSpeechSynthesizer()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let done = ResumeOnce(continuation)
            synthesizer.write(utterance) { buffer in
                guard let input = buffer as? AVAudioPCMBuffer else { return }
                // A zero-length buffer is the documented end-of-synthesis
                // signal; without it this call never completes.
                if input.frameLength == 0 {
                    done.resume(())
                    return
                }
                sink.append(input, to: outFormat)
            }
        }

        if let failure = sink.failure {
            write(["id": request.id, "error": "synthesis_failed", "reason": failure])
            return
        }
        let pcm = sink.pcm
        guard !pcm.isEmpty else {
            write(["id": request.id, "error": "synthesis_failed", "reason": "no audio produced"])
            return
        }
        do {
            try wavData(pcm: pcm, sampleRate: Int(sampleRate)).write(to: URL(fileURLWithPath: outPath))
        } catch {
            write(["id": request.id, "error": "synthesis_failed", "reason": String(describing: error)])
            return
        }
        write([
            "id": request.id,
            "wav": outPath,
            "sampleRate": Int(sampleRate),
            "samples": pcm.count / 2,
            "durationMs": Int(Double(pcm.count / 2) / sampleRate * 1000.0),
        ])
    }

    /// Canonical 44-byte RIFF header + samples. Kept here rather than shelling
    /// out so the helper stays the single bundled binary.
    private static func wavData(pcm: Data, sampleRate: Int) -> Data {
        var out = Data()
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { out.append(contentsOf: $0) } }
        out.append(contentsOf: Array("RIFF".utf8)); u32(36 + pcm.count)
        out.append(contentsOf: Array("WAVE".utf8))
        out.append(contentsOf: Array("fmt ".utf8)); u32(16)
        u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        out.append(contentsOf: Array("data".utf8)); u32(pcm.count)
        out.append(pcm)
        return out
    }

    private static func healthResponse(id: Int) -> [String: Any] {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability {
                return ["id": id, "status": "ready"]
            }
            return ["id": id, "status": "unavailable", "reason": unavailableReason()]
        }
        return ["id": id, "status": "unavailable", "reason": "macOS 26 or later required"]
#else
        return ["id": id, "status": "unavailable", "reason": "FoundationModels framework not present"]
#endif
    }

    private static func unavailableReason() -> String {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return "available"
            case .unavailable(let reason):
                return "unavailable: \(reason)"
            @unknown default:
                return "unavailable: unknown state"
            }
        }
        return "macOS 26 or later required"
#else
        return "FoundationModels framework not present"
#endif
    }

    private static func write(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    }
}

/// One-shot continuation guard: speech and synthesis callbacks can fire more
/// than once, and resuming a continuation twice traps.
private final class ResumeOnce<T>: @unchecked Sendable {
    private var continuation: CheckedContinuation<T, Never>?
    private let lock = NSLock()

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    func resume(_ value: T) {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(returning: value)
    }
}

/// Accumulates synthesized audio, resampling each delivered buffer to the
/// target format. The converter is built from the first buffer because the
/// synthesizer picks its own rate and sample type per voice.
private final class PCMSink: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var converter: AVAudioConverter?
    private var error: String?

    var pcm: Data {
        lock.lock(); defer { lock.unlock() }
        return buffer
    }

    var failure: String? {
        lock.lock(); defer { lock.unlock() }
        return error
    }

    func append(_ input: AVAudioPCMBuffer, to outFormat: AVAudioFormat) {
        lock.lock(); defer { lock.unlock() }
        if error != nil { return }
        if converter == nil {
            converter = AVAudioConverter(from: input.format, to: outFormat)
            if converter == nil {
                error = "no converter from \(input.format) to \(outFormat)"
                return
            }
        }
        guard let converter else { return }
        // Round up, and leave slack: the converter may emit slightly more than
        // the naive ratio when it flushes filter state.
        let ratio = outFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else {
            error = "output buffer allocation failed"
            return
        }
        var supplied = false
        var convertError: NSError?
        let status = converter.convert(to: output, error: &convertError) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }
        if status == .error {
            error = convertError?.localizedDescription ?? "conversion failed"
            return
        }
        guard let channel = output.int16ChannelData, output.frameLength > 0 else { return }
        let count = Int(output.frameLength)
        channel[0].withMemoryRebound(to: UInt8.self, capacity: count * 2) { raw in
            buffer.append(raw, count: count * 2)
        }
    }
}

private final class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: ResumeOnce<Void>?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish?.resume(())
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onFinish?.resume(())
    }
}
