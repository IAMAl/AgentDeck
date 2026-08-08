#if os(macOS)
import XCTest
@testable import AgentDeck

/// Pairing-token convergence between the two daemons that can serve one machine.
///
/// The Node CLI daemon and this app's in-process daemon keep their token in
/// different files, and the sandboxed app cannot read `~/.agentdeck/auth-token`.
/// Whichever daemon owned the port therefore decided whether every paired ESP32
/// board authenticated, and a handover in either direction closed the whole
/// fleet 4001. `adoptPeerToken` fixes that: whoever starts second adopts what
/// the incumbent already serves.
///
/// These drive `AuthManager.adoption`, the pure core, on purpose —
/// `AuthManager.shared` wraps the machine's real credential file and a test
/// that exercised it could un-pair the user's devices. Mirrors
/// `bridge/src/__tests__/auth-token-adoption.test.ts`.
final class AuthTokenAdoptionTests: XCTestCase {
    private let tokenA = String(repeating: "a", count: 32)
    private let tokenB = String(repeating: "b", count: 32)
    private let tokenC = String(repeating: "c", count: 32)

    func testAdoptsTheIncumbentToken() {
        let outcome = AuthManager.adoption(of: tokenB, current: tokenA, ring: [])
        XCTAssertEqual(outcome?.token, tokenB)
    }

    func testKeepsTheSupersededTokenAccepted() {
        // A board provisioned a moment before the handover still holds tokenA.
        let outcome = AuthManager.adoption(of: tokenB, current: tokenA, ring: [])
        XCTAssertEqual(outcome?.ring, [tokenA])
    }

    func testIsNoOpWhenTheIncumbentServesWhatWeAlreadyHold() {
        XCTAssertNil(AuthManager.adoption(of: tokenA, current: tokenA, ring: []))
    }

    func testRefusesMissingOrMalformedTokenRatherThanAdoptingABlankCredential() {
        for bad in [nil, "", "   ", "short"] as [String?] {
            XCTAssertNil(AuthManager.adoption(of: bad, current: tokenA, ring: []),
                         "adopted a malformed credential: \(String(describing: bad))")
        }
    }

    func testBoundsTheAcceptedRing() {
        var current = tokenA
        var ring: [String] = []
        for i in 0..<8 {
            guard let outcome = AuthManager.adoption(
                of: String(repeating: String(i), count: 32), current: current, ring: ring) else { continue }
            current = outcome.token
            ring = outcome.ring
        }
        XCTAssertLessThanOrEqual(ring.count, 4)
    }

    func testNeverRecordsTheSameTokenTwice() {
        var current = tokenA
        var ring: [String] = []
        for candidate in [tokenB, tokenA, tokenB, tokenC] {
            guard let outcome = AuthManager.adoption(of: candidate, current: current, ring: ring) else { continue }
            current = outcome.token
            ring = outcome.ring
        }
        XCTAssertEqual(Set(ring).count, ring.count)
        XCTAssertFalse(ring.contains(current), "the served token must not also sit in the accepted ring")
    }
}
#endif
