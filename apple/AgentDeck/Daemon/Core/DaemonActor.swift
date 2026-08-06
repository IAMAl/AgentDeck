#if os(macOS)
import Foundation

// DaemonActor.swift — the executor the in-process daemon runs on.
//
// The daemon used to be `@MainActor`, which meant SwiftUI rendering and daemon
// service shared one executor: a saturated main runloop starved the daemon
// (measured 2026-07-18 — `/health` unanswered for 5s, log stalled 24 minutes,
// process alive the whole time).
//
// This is a *global* actor rather than making `DaemonServer` an `actor`
// because the daemon is not one object. `StateMachine`, `ModuleManager`,
// `ApmeCollector` and friends hold daemon state too, and their callers use
// synchronous value-returning methods (`transition() -> Bool`,
// `activeTaskId`) and pass non-Sendable dictionaries. Making each an
// independent `actor` would force `await` across ~105 call sites and put a
// Sendable boundary where none is wanted; leaving them as plain classes leaves
// them with no isolation to inherit, so `Task {}` inside their methods becomes
// a concurrent context (this is exactly what broke `resetStuckTimer`).
//
// A shared global actor gives all of them one nameable isolation: calls
// between them stay synchronous, `Task {}` inside their methods inherits the
// daemon's executor just as it used to inherit the main actor's, and the
// compiler still enforces that nothing leaks across the boundary.
//
// The rule: anything that holds daemon state is `@DaemonActor`. UI-facing
// types stay `@MainActor` and are reached with `await`.
@globalActor
actor DaemonActor {
    static let shared = DaemonActor()

    /// Mirror of `MainActor.run` for the daemon's executor: run a body on
    /// `DaemonActor` from a nonisolated context (HTTP route handlers, module
    /// callbacks) and hand the result back. The daemon's `MainActor.run` sites
    /// became these — same shape, different executor.
    @DaemonActor
    static func run<T>(
        resultType: T.Type = T.self,
        body: @DaemonActor () throws -> T
    ) async rethrows -> T {
        try body()
    }
}

/// One-way "it finished" flag. Separate from the waiter on purpose: the waiter
/// polls it and may walk away, which a continuation-based signal cannot express
/// without risking a resume-after-abandon.
private actor CompletionFlag {
    private var done = false
    func mark() { done = true }
    var isDone: Bool { done }
}

/// Run `work` under a wall-clock budget, ABANDONING it if the budget is blown.
///
/// Teardown needs its caller to make progress even when a stage never will, and
/// the two obvious tools both fail at exactly that:
///
///   - `withTaskGroup` awaits *every* child at scope exit, so one wedged child
///     hangs the caller anyway — this is precisely how `ModuleManager.stopAll()`
///     (a task group over module `stop()`s) stalled the whole daemon shutdown.
///   - Cancellation is cooperative, and a subsystem parked on a continuation
///     that will never resume — a BLE reply that never arrives — never observes
///     it.
///
/// So the stage is left running and forgotten. That is a deliberate trade: an
/// abandoned stage may still hold a transport that the next start() re-opens,
/// which is why blowing the budget logs at ERROR. Hanging forever is strictly
/// worse — it stranded this daemon on a fallback port for the rest of its life
/// (2026-08-06), with the reclaim guard latched so nothing ever retried.
///
/// Returns true when `work` finished inside the budget.
@discardableResult
func withBudget(
    seconds: Double,
    _ label: String,
    poll: Double = 0.02,
    _ work: @escaping @Sendable () async -> Void
) async -> Bool {
    let flag = CompletionFlag()
    Task.detached(priority: .high) {
        await work()
        await flag.mark()
    }
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if await flag.isDone { return true }
        try? await Task.sleep(nanoseconds: UInt64(poll * 1_000_000_000))
    }
    if await flag.isDone { return true }
    DaemonLogger.shared.error(
        "Teardown stage '\(label)' exceeded \(seconds)s — abandoning it so shutdown can finish")
    return false
}
#endif
