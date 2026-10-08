import Foundation
import Security
import CryptoKit
// Private bytes stay inside this helper and the OS credential store.
let service = "horizon.authority.ed25519"
func fail(_ code: String) -> Never {
    print("{\"error\":\"\(code)\"}")
    exit(1)
}
func query(_ ref: String) -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: ref]
}
func load(_ ref: String) -> Curve25519.Signing.PrivateKey {
    var q = query(ref); q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
        fail("KEYCHAIN_SIGNER_UNAVAILABLE")
    }
    do { return try Curve25519.Signing.PrivateKey(rawRepresentation: data) }
    catch { fail("KEYCHAIN_SIGNER_CORRUPT") }
}
func output(_ value: [String: Any]) {
    do { let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!) }
    catch { fail("PUBLIC_OUTPUT_FAILED") }
}
let args = CommandLine.arguments
if args.count == 2 && args[1] == "capabilities" {
    output(["algorithm":"Ed25519", "storage":"OS_SECURE_CREDENTIAL_STORE", "backend":"macOS Keychain/Security.framework + CryptoKit", "privateKeyExport":false]); exit(0)
}
guard args.count == 3 else { fail("INVALID_OPERATION") }
let op = args[1], ref = args[2]
guard ref.range(of: "^[a-z0-9][a-z0-9:._-]{1,160}$", options: .regularExpression) != nil else { fail("INVALID_SIGNER_REFERENCE") }
if op == "create" {
    var q = query(ref); q[kSecReturnAttributes as String] = true
    var existing: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &existing)
    guard status == errSecItemNotFound else { fail(status == errSecSuccess ? "KEY_ALREADY_EXISTS" : "KEYCHAIN_UNAVAILABLE") }
    let key = Curve25519.Signing.PrivateKey()
    var add = query(ref)
    add[kSecValueData as String] = key.rawRepresentation
    add[kSecAttrLabel as String] = "Horizon authority Ed25519 " + ref
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { fail("KEYCHAIN_WRITE_FAILED") }
    // Verify persisted key possession before public output; never retry key creation.
    let stored = load(ref)
    guard stored.publicKey.rawRepresentation == key.publicKey.rawRepresentation else { fail("KEYCHAIN_PUBLIC_BINDING_MISMATCH") }
    output(["publicKeyRaw":stored.publicKey.rawRepresentation.base64EncodedString(), "storage":"OS_SECURE_CREDENTIAL_STORE"])
} else if op == "delete" {
    guard ref.hasPrefix("horizon:p92:npt:hv:") || ref.hasPrefix("horizon:p92:npt:dr:") else { fail("TEST_KEY_TEARDOWN_TARGET_INVALID") }
    let status = SecItemDelete(query(ref) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail("TEST_KEY_TEARDOWN_INCOMPLETE") }
    var q = query(ref); q[kSecReturnAttributes as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecItemNotFound else { fail("TEST_KEY_TEARDOWN_INCOMPLETE") }
    output(["result":"TEST_KEY_ENTRY_ABSENT", "privateKeyExport":false])
} else if op == "public" {
    output(["publicKeyRaw":load(ref).publicKey.rawRepresentation.base64EncodedString(), "storage":"OS_SECURE_CREDENTIAL_STORE"])
} else if op == "sign" {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count > 0 && input.count <= 1048576 else { fail("INVALID_SIGNING_INPUT") }
    do { output(["signature":try load(ref).signature(for: input).base64EncodedString()]) }
    catch { fail("SIGNING_FAILED") }
} else { fail("INVALID_OPERATION") }
