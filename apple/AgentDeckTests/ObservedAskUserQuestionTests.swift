#if os(macOS)
import XCTest
@testable import AgentDeck

final class ObservedAskUserQuestionTests: XCTestCase {
    func testParsesStructuredQuestionOptionsAndToolUseId() {
        let parsed = DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu-ask-1",
            "tool_input": [
                "questions": [[
                    "question": "  응답 대기 PR/이슈에   stale nudge를 게시할까요? ",
                    "header": "유예기간",
                    "options": [
                        ["label": "14일 유예 후 close", "description": "표준 유예"],
                        ["label": "7일 유예 후 close", "description": "빠른 정리"],
                    ],
                    "multiSelect": false,
                ]],
            ],
        ])

        XCTAssertEqual(parsed?.toolUseId, "toolu-ask-1")
        XCTAssertEqual(parsed?.question, "응답 대기 PR/이슈에 stale nudge를 게시할까요?")
        XCTAssertEqual(parsed?.options.count, 2)
        XCTAssertEqual(parsed?.options[0]["index"]?.value as? Int, 0)
        XCTAssertEqual(parsed?.options[0]["label"]?.value as? String, "14일 유예 후 close")
        XCTAssertEqual(parsed?.options[1]["index"]?.value as? Int, 1)
        XCTAssertEqual(parsed?.options[1]["label"]?.value as? String, "7일 유예 후 close")
        XCTAssertNil(parsed?.promptType)
    }

    func testRejectsMissingToolUseIdOrChoices() {
        XCTAssertNil(DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_input": [
                "questions": [[
                    "question": "Choose one",
                    "options": [["label": "A"]],
                ]],
            ],
        ]))
        XCTAssertNil(DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu-empty",
            "tool_input": [
                "questions": [[
                    "question": "Choose one",
                    "options": [],
                ]],
            ],
        ]))
    }

    func testMapsFailureHookToExplicitToolFailureBoundary() {
        XCTAssertEqual(
            DaemonServer.mapHookEventName("PostToolUseFailure"),
            "tool_failure"
        )
    }
}
#endif
