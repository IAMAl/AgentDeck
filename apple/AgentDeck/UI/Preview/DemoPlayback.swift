// DemoPlayback.swift — a scripted session, so a preview can show AgentDeck working.
//
// The device gallery could only ever show hardware sitting still: a Stream Deck
// with placeholder keys, an e-ink panel frozen mid-thought. That answers "what
// does this device look like" and not the question people actually have, which
// is "what does AgentDeck DO". The demo video answers it in twenty seconds, and
// the machinery behind that video was already here — `scripts/appstore-demo-
// orchestrator.mjs` scripts a multi-agent arc and speaks the real protocol at a
// recording rig.
//
// This is that arc, moved in-process. It synthesizes a `DashboardState` per
// instant and hands it to the same `LivePreviewData.from` the live-follow path
// uses, so every preview — including the pixel-exact Pixoo/D200H emulators —
// animates through a real day's worth of agent activity without a Mac, a
// daemon, or a network. No renderer knows the difference, which is the point:
// if the demo needed its own drawing code it would drift from the product.
//
// Everything below is fiction. The project names are this repository's own and
// the percentages are invented; nothing here reads user state.

import Foundation

enum DemoPlayback {

    /// One beat of the scripted arc. `at` is seconds from the loop's start; a
    /// beat holds until the next one begins.
    struct Beat {
        let at: TimeInterval
        let top: AgentConnectionState
        let agentType: String
        let sessions: [SessionInfo]
        let fiveHour: Double
        let sevenDay: Double
        let codexPrimary: Double
        let codexSecondary: Double
        /// Shown on surfaces that render the focused session's question.
        var question: String? = nil
        var options: [PromptOption] = []
    }

    /// Loop length. Matches the recorded demo so the two read as one story.
    static let loopSeconds: TimeInterval = 28

    private static func session(
        _ id: String, _ port: Int, _ project: String, _ agent: String,
        _ state: String, _ model: String, tool: String? = nil,
        question: String? = nil, options: [PromptOption] = []
    ) -> SessionInfo {
        SessionInfo(
            id: id, port: port, projectName: project, agentType: agent,
            alive: true, state: state, modelName: model, startedAt: nil,
            currentTool: tool, question: question,
            options: options.isEmpty ? nil : options
        )
    }

    /// The arc: one agent wakes, a second joins, one stops to ask a question,
    /// the answer lands, a third joins, then the desk goes quiet again. It is
    /// deliberately the same shape as the recorded demo — idle is where it
    /// starts and ends, because "the task goes quiet" is the product's promise.
    static let beats: [Beat] = [
        Beat(at: 0, top: .idle, agentType: "claude-code",
             sessions: [session("s1", 9121, "AgentDeck", "claude-code", "idle", "claude-fable-5")],
             fiveHour: 12, sevenDay: 31, codexPrimary: 4, codexSecondary: 22),

        Beat(at: 3, top: .processing, agentType: "claude-code",
             sessions: [session("s1", 9121, "AgentDeck", "claude-code", "processing", "claude-fable-5", tool: "Read")],
             fiveHour: 16, sevenDay: 32, codexPrimary: 4, codexSecondary: 22),

        Beat(at: 7, top: .processing, agentType: "claude-code",
             sessions: [
                session("s1", 9121, "AgentDeck", "claude-code", "processing", "claude-fable-5", tool: "Edit"),
                session("s2", 9122, "BabelForge", "codex-cli", "processing", "gpt-5", tool: "Bash"),
             ],
             fiveHour: 21, sevenDay: 34, codexPrimary: 9, codexSecondary: 24),

        // The moment the product exists for: an agent stops and asks, and the
        // question reaches every surface instead of one terminal nobody is
        // looking at.
        Beat(at: 12, top: .awaitingPermission, agentType: "claude-code",
             sessions: [
                session("s1", 9121, "AgentDeck", "claude-code", "awaiting_permission", "claude-fable-5",
                        question: "Run the release build?",
                        options: [PromptOption(index: 0, label: "Yes"), PromptOption(index: 1, label: "No")]),
                session("s2", 9122, "BabelForge", "codex-cli", "processing", "gpt-5", tool: "Bash"),
             ],
             fiveHour: 24, sevenDay: 35, codexPrimary: 13, codexSecondary: 25,
             question: "Run the release build?",
             options: [PromptOption(index: 0, label: "Yes"), PromptOption(index: 1, label: "No")]),

        Beat(at: 17, top: .processing, agentType: "claude-code",
             sessions: [
                session("s1", 9121, "AgentDeck", "claude-code", "processing", "claude-fable-5", tool: "Bash"),
                session("s2", 9122, "BabelForge", "codex-cli", "processing", "gpt-5", tool: "Write"),
                session("s3", 9123, "foundby-site", "opencode", "processing", "glm-5.2", tool: "Grep"),
             ],
             fiveHour: 29, sevenDay: 37, codexPrimary: 18, codexSecondary: 27),

        Beat(at: 22, top: .processing, agentType: "claude-code",
             sessions: [
                session("s1", 9121, "AgentDeck", "claude-code", "idle", "claude-fable-5"),
                session("s2", 9122, "BabelForge", "codex-cli", "processing", "gpt-5", tool: "Edit"),
                session("s3", 9123, "foundby-site", "opencode", "idle", "glm-5.2"),
             ],
             fiveHour: 33, sevenDay: 38, codexPrimary: 21, codexSecondary: 28),

        Beat(at: 25, top: .idle, agentType: "claude-code",
             sessions: [
                session("s1", 9121, "AgentDeck", "claude-code", "idle", "claude-fable-5"),
                session("s2", 9122, "BabelForge", "codex-cli", "idle", "gpt-5"),
                session("s3", 9123, "foundby-site", "opencode", "idle", "glm-5.2"),
             ],
             fiveHour: 35, sevenDay: 39, codexPrimary: 23, codexSecondary: 29),
    ]

    /// The beat covering `elapsed`, looping.
    static func beat(at elapsed: TimeInterval) -> Beat {
        let t = loopSeconds > 0 ? elapsed.truncatingRemainder(dividingBy: loopSeconds) : 0
        let position = t < 0 ? t + loopSeconds : t
        var current = beats[0]
        for b in beats where b.at <= position { current = b }
        return current
    }

    /// A synthetic daemon state for `elapsed`, shaped exactly like the real one
    /// so `LivePreviewData.from` and `liveSelectionInputs` need no demo branch.
    static func state(at elapsed: TimeInterval) -> DashboardState {
        let b = beat(at: elapsed)
        var state = DashboardState()
        state.bridgeConnected = true
        state.state = b.top
        state.agentType = b.agentType
        state.siblingSessions = b.sessions
        state.focusedSessionId = b.sessions.first?.id
        state.sessionId = b.sessions.first?.id
        state.question = b.question
        state.options = b.options
        state.fiveHourPercent = b.fiveHour
        state.sevenDayPercent = b.sevenDay
        state.usageStale = false
        state.codexRateLimits = CodexRateLimits(
            primary: CodexRateLimitWindow(
                usedPercent: b.codexPrimary, windowMinutes: 300, resetsAt: nil, stale: false),
            secondary: CodexRateLimitWindow(
                usedPercent: b.codexSecondary, windowMinutes: 10080, resetsAt: nil, stale: false),
            planType: nil, limitId: nil, credits: nil
        )
        return state
    }
}
