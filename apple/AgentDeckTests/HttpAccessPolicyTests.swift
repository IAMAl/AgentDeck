#if os(macOS)
// HttpAccessPolicyTests.swift — LAN default-deny policy matrix (issue #145).
// Mirrors bridge/src/__tests__/http-auth-gate.test.ts: unauthenticated LAN
// peers reach only a minimal GET /health (no pairingToken, no modules, no
// state); everything else is 401. Same-machine or token-bearing requests
// pass through untouched.

import XCTest
@testable import AgentDeck

final class HttpAccessPolicyTests: XCTestCase {

    private func decision(
        method: String = "GET", path: String, isLocal: Bool = false, tokenValid: Bool = false
    ) -> HTTPServer.HTTPResponse? {
        DaemonServer.httpAccessResponse(
            method: method, path: path, isLocal: isLocal, tokenValid: tokenValid, daemonPort: 9120)
    }

    private func json(_ response: HTTPServer.HTTPResponse) -> [String: Any] {
        guard let body = response.body,
              let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return [:]
        }
        return obj
    }

    func testAuthorizedRequestsPassThrough() {
        XCTAssertNil(decision(path: "/status", isLocal: true))
        XCTAssertNil(decision(path: "/status", tokenValid: true))
        XCTAssertNil(decision(method: "POST", path: "/hooks/Stop", isLocal: true))
        XCTAssertNil(decision(path: "/health", tokenValid: true), "full /health stays reachable when authorized")
    }

    func testUnauthenticatedHealthIsMinimalAndSecretFree() throws {
        let response = try XCTUnwrap(decision(path: "/health"))
        XCTAssertEqual(response.status, 200)
        let payload = json(response)
        XCTAssertEqual(payload["authRequired"] as? Bool, true)
        XCTAssertEqual(payload["mode"] as? String, "daemon")
        // Belt-and-braces: nothing credential- or state-shaped leaks.
        let flat = String(data: response.body ?? Data(), encoding: .utf8)?.lowercased() ?? ""
        for needle in ["token", "modules", "apme", "state", "pid"] {
            XCTAssertFalse(flat.contains(needle), "public /health leaked '\(needle)'")
        }
    }

    func testEverythingElseIsDeniedForUnauthenticatedPeers() throws {
        let sensitive: [(String, String)] = [
            ("GET", "/status"), ("GET", "/usage"), ("GET", "/devices"), ("GET", "/sse"),
            ("GET", "/timeline"), ("POST", "/hooks/Stop"), ("POST", "/shutdown"),
            ("POST", "/esp32/ota"), ("POST", "/health"),
        ]
        for (method, path) in sensitive {
            let response = try XCTUnwrap(decision(method: method, path: path), "\(method) \(path)")
            XCTAssertEqual(response.status, 401, "\(method) \(path)")
        }
    }
}
#endif
