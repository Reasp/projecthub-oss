import Foundation
import Capacitor
import CryptoKit
import LocalAuthentication
import Security

/**
 Device key and token storage (TASK-140.18, decision-79 p. 2), the iOS side of `PhSecureStore`
 (`mobile/src/platform/secureStore.ts`). Values live in the Keychain of this device only: no iCloud sync and no
 migration to another phone from a backup. Crypto comes from the OS only (decision-79 p. 10). Profiles are never
 written to WebView storage (localStorage, IndexedDB).

 No push methods: a free Apple ID has no APNs, so the client gets no push port (`createPushPort` returns `null`).
 */
@objc(PhSecureStorePlugin)
public class PhSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhSecureStorePlugin"
    public let jsName = "PhSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createConfirmKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signConfirm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteConfirmKey", returnType: CAPPluginReturnPromise)
    ]

    private static let service = "com.projecthub.mobile.securestore"

    private func requireKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return nil
        }
        return key
    }

    private func itemQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: PhSecureStorePlugin.service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        var query = itemQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            call.resolve(["value": NSNull()])
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("value is required")
            return
        }
        let data = Data(value.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(itemQuery(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = itemQuery(key)
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("secure store write failed (\(status))")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        SecItemDelete(itemQuery(key) as CFDictionary)
        call.resolve()
    }

    // MARK: - HITL confirm key with biometrics (decision-112 p. 4, decision-114)
    //
    // ECDSA P-256 in the Secure Enclave, one per pairing. The private part never leaves the enclave, and every
    // signature needs Face ID / Touch ID (`biometryCurrentSet`): a new fingerprint or face invalidates the key and the
    // device is paired again, like on Android.

    private static let confirmPrefix = "projecthub_confirm_"

    /** SubjectPublicKeyInfo header for an uncompressed P-256 point: the host expects SPKI DER, as Android sends it. */
    private static let p256SpkiHeader: [UInt8] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    ]

    private func confirmTag(_ call: CAPPluginCall) -> Data? {
        guard let id = call.getString("id"), id.range(of: "^[A-Za-z0-9_.-]{1,96}$", options: .regularExpression) != nil else {
            call.reject("id is required", "bad_id")
            return nil
        }
        return Data((PhSecureStorePlugin.confirmPrefix + id).utf8)
    }

    private func keyQuery(_ tag: Data) -> [String: Any] {
        return [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: tag
        ]
    }

    /** Why biometrics are unavailable; `nil` means available. */
    private func biometricUnavailableReason() -> String? {
        if !SecureEnclave.isAvailable { return "no_hardware" }
        let context = LAContext()
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) { return nil }
        switch (error as? LAError)?.code {
        case .passcodeNotSet: return "no_lock"
        case .biometryNotEnrolled: return "not_enrolled"
        case .biometryNotAvailable: return "no_hardware"
        case .biometryLockout: return "lockout"
        default: return "unavailable"
        }
    }

    @objc func confirmStatus(_ call: CAPPluginCall) {
        if let reason = biometricUnavailableReason() {
            call.resolve(["available": false, "reason": reason])
        } else {
            call.resolve(["available": true])
        }
    }

    /** New pairing key (the previous one with the same id is replaced). Returns SPKI DER in base64url. */
    @objc func createConfirmKey(_ call: CAPPluginCall) {
        guard let tag = confirmTag(call) else { return }
        if let reason = biometricUnavailableReason() {
            call.reject("biometric unavailable: \(reason)", reason)
            return
        }
        SecItemDelete(keyQuery(tag) as CFDictionary)
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            nil
        ) else {
            call.reject("confirm key generation failed", "failed")
            return
        }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag,
                kSecAttrAccessControl as String: access
            ]
        ]
        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
              let publicKey = SecKeyCopyPublicKey(privateKey),
              let point = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
            call.reject("confirm key generation failed", "failed")
            return
        }
        let spki = Data(PhSecureStorePlugin.p256SpkiHeader) + point
        call.resolve(["publicKey": PhSecureStorePlugin.base64url(spki)])
    }

    /** Signs the decision string after Face ID / Touch ID. Returns a DER signature in base64url. */
    @objc func signConfirm(_ call: CAPPluginCall) {
        guard let tag = confirmTag(call) else { return }
        guard let payload = call.getString("payload"), !payload.isEmpty, payload.count <= 4096 else {
            call.reject("payload is required", "bad_payload")
            return
        }
        let reason = [call.getString("title"), call.getString("subtitle"), call.getString("description")]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        let context = LAContext()
        context.localizedCancelTitle = Locale.preferredLanguages.first?.hasPrefix("ru") == true ? "Отмена" : "Cancel"
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason.isEmpty ? "ProjectHub" : reason) { ok, error in
            guard ok else {
                switch (error as? LAError)?.code {
                case .userCancel, .appCancel, .systemCancel, .userFallback:
                    call.reject("cancelled", "cancelled")
                case .biometryLockout:
                    call.reject("lockout", "lockout")
                default:
                    call.reject(error?.localizedDescription ?? "failed", "failed")
                }
                return
            }
            // The context is already authenticated: the key is used without a second prompt.
            context.interactionNotAllowed = true
            var query = self.keyQuery(tag)
            query[kSecReturnRef as String] = true
            query[kSecUseAuthenticationContext as String] = context
            var item: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            guard status == errSecSuccess, let found = item else {
                call.reject("no confirm key", "no_key")
                return
            }
            // swiftlint:disable:next force_cast
            let key = found as! SecKey
            var signError: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(payload.utf8) as CFData, &signError) as Data? else {
                // Biometrics passed but the key refuses: the enrolled faces or fingers changed (`biometryCurrentSet`).
                call.reject("confirm key invalidated", "invalidated")
                return
            }
            call.resolve(["signature": PhSecureStorePlugin.base64url(signature)])
        }
    }

    @objc func deleteConfirmKey(_ call: CAPPluginCall) {
        guard let tag = confirmTag(call) else { return }
        SecItemDelete(keyQuery(tag) as CFDictionary)
        call.resolve()
    }

    static func base64url(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
