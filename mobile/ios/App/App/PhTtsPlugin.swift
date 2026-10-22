import AVFoundation
import Capacitor

/**
 Voice mode speech (TASK-179.2, decision-137 p. 8), the iOS side of `PhTts` (`mobile/src/platform/tts.ts`): the system
 synthesizer of the phone, no network and no PC involved. `speak` settles when the phrase is finished or interrupted.
 */
@objc(PhTtsPlugin)
public class PhTtsPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "PhTtsPlugin"
    public let jsName = "PhTts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let synthesizer = AVSpeechSynthesizer()
    /** Calls waiting for their phrase, by utterance. Touched on the main queue only. */
    private var pending: [ObjectIdentifier: CAPPluginCall] = [:]

    override public func load() {
        synthesizer.delegate = self
        // Own audio session: speech must not reconfigure the WebView's microphone recording in voice mode.
        synthesizer.usesApplicationAudioSession = false
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true, "ready": true])
    }

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            call.resolve()
            return
        }
        let language = call.getString("lang") == "en" ? "en-US" : "ru-RU"
        guard let voice = AVSpeechSynthesisVoice(language: language) else {
            call.reject("tts_language_missing")
            return
        }
        DispatchQueue.main.async {
            // A new phrase interrupts the previous one: voice mode does not queue answers.
            if self.synthesizer.isSpeaking { self.synthesizer.stopSpeaking(at: .immediate) }
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = voice
            self.pending[ObjectIdentifier(utterance)] = call
            self.synthesizer.speak(utterance)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.synthesizer.stopSpeaking(at: .immediate)
            for pendingCall in self.pending.values { pendingCall.resolve() }
            self.pending.removeAll()
            call.resolve()
        }
    }

    private func finish(_ utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.pending.removeValue(forKey: ObjectIdentifier(utterance))?.resolve()
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish(utterance)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finish(utterance)
    }
}
