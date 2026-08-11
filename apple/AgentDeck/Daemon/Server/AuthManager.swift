#if os(macOS)
// AuthManager.swift — Token generation, validation, local connection detection
// Ported from bridge/src/auth.ts

import Foundation
import Security

final class AuthManager: Sendable {
    static let shared = AuthManager()

    /// Base AgentDeck data directory. Delegates to `AgentDeckPaths` which
    /// resolves to the App Store sandbox container when sandboxed and falls
    /// back to the legacy `~/.agentdeck/` layout otherwise.
    static var agentDeckDir: URL { AgentDeckPaths.baseDirectory }
    static var tokenFile: URL { AgentDeckPaths.authToken }
    private static let tokenLength = 32 // 32 hex chars = 16 bytes

    private static func string(from nullTerminatedBytes: [CChar]) -> String {
        let bytes = nullTerminatedBytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    private let cachedToken: String

    private init() {
        self.cachedToken = AuthManager.loadOrCreateToken()
    }

    var token: String { cachedToken }

    // MARK: - Token Management

    private static func loadOrCreateToken() -> String {
        // macOS 26 sandbox container I/O can silently block the very
        // first `Data(contentsOf:)` on auth-token at `__open` syscall —
        // sample shows main thread stuck in `_fcntl_overlay_open` →
        // `__open`, no sandboxd deny in system log. That stalls the entire
        // daemon startup (`DaemonServer.init` → `AuthManager.shared` is
        // called sync from main actor) and makes the GUI look frozen.
        //
        // Run the read on a background queue with a short timeout. If the
        // syscall never returns we treat it as "no existing token" and
        // generate a fresh one — the dashboard's auth token is dashboard-
        // only state, regenerating it doesn't break any external integration.
        // The write also runs on a background queue, so a hung write
        // doesn't block startup either.
        let semaphore = DispatchSemaphore(value: 0)
        let loaded = AuthTokenReadBox()
        DispatchQueue.global(qos: .userInitiated).async {
            defer { semaphore.signal() }
            guard let data = try? Data(contentsOf: tokenFile),
                  let existing = String(data: data, encoding: .utf8)?
                      .trimmingCharacters(in: .whitespacesAndNewlines),
                  existing.count >= tokenLength else { return }
            loaded.set(existing)
        }
        if semaphore.wait(timeout: .now() + 2) == .timedOut {
            DaemonLogger.shared.error("AuthManager: token-file read timed out (sandbox first-launch?), generating fresh token")
        } else if let token = loaded.get() {
            return token
        }

        // Generate new token
        var bytes = [UInt8](repeating: 0, count: tokenLength / 2)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let token = bytes.map { String(format: "%02x", $0) }.joined()

        // Write fire-and-forget on a background queue; if it hangs the
        // next launch will hit the timeout path again and stay
        // functional rather than freezing the daemon.
        DispatchQueue.global(qos: .utility).async {
            do {
                try FileManager.default.createDirectory(at: agentDeckDir, withIntermediateDirectories: true)
                try (token + "\n").write(to: tokenFile, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: tokenFile.path
                )
                DaemonLogger.shared.debug("auth", "Generated new auth token")
            } catch {
                DaemonLogger.shared.error("Failed to write token file: \(error)")
            }
        }

        return token
    }

    // MARK: - Validation

    func validateToken(_ candidate: String) -> Bool {
        let stored = cachedToken
        guard candidate.count == stored.count else { return false }
        // Constant-time comparison
        var result: UInt8 = 0
        for (a, b) in zip(candidate.utf8, stored.utf8) {
            result |= a ^ b
        }
        return result == 0
    }

    // MARK: - Local Connection Detection

    func isLocalConnection(_ ip: String) -> Bool {
        if ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1" { return true }

        // Check against this machine's network interfaces
        let localIPs = Self.getLocalIPAddresses()
        return localIPs.contains(ip) || localIPs.contains(where: { "::ffff:\($0)" == ip })
    }

    // MARK: - Network Helpers

    static func getLanIP() -> String? {
        // Prefer the default-route interface's IPv4 so a dual-homed host (e.g.
        // en0 + en1 on the same subnet) advertises the address a remote device
        // can actually reach, not an arbitrary secondary one. App-Store-safe: a
        // UDP "connect" sends no packet — it just makes the kernel resolve the
        // source address via the route table (no subprocess, unlike `route`).
        if let routed = primaryRouteIP() { return routed }

        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            let addr = ptr.pointee.ifa_addr.pointee
            guard addr.sa_family == UInt8(AF_INET) else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = Self.string(from: hostname)
                if !ip.hasPrefix("169.254.") { return ip } // Skip link-local
            }
        }
        return nil
    }

    /// IPv4 of the default-route interface via the UDP-connect source-address
    /// trick (no packet leaves the host). Returns nil when there's no route.
    private static func primaryRouteIP() -> String? {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var dest = sockaddr_in()
        dest.sin_family = sa_family_t(AF_INET)
        dest.sin_port = in_port_t(53).bigEndian
        inet_pton(AF_INET, "8.8.8.8", &dest.sin_addr)
        let connected = withUnsafePointer(to: &dest) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else { return nil }

        var local = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &local) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        guard named == 0 else { return nil }

        var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &local.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
        let ip = Self.string(from: buf)
        if ip.isEmpty || ip == "0.0.0.0" || ip.hasPrefix("169.254.") { return nil }
        return ip
    }

    private static func getLocalIPAddresses() -> Set<String> {
        var result = Set<String>()
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return result }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let addr = ptr.pointee.ifa_addr.pointee
            guard addr.sa_family == UInt8(AF_INET) || addr.sa_family == UInt8(AF_INET6) else { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                result.insert(Self.string(from: hostname))
            }
        }
        return result
    }

    func getWsUrl(port: Int) -> String {
        let ip = Self.getLanIP() ?? "127.0.0.1"
        return "ws://\(ip):\(port)?token=\(cachedToken)"
    }
}

private final class AuthTokenReadBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func set(_ value: String) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
#endif
