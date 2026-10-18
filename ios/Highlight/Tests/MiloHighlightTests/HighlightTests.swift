import XCTest
@testable import MiloHighlight

/// The cases on disk, read by the browser's test too. A case this side reads differently from
/// `src/core/highlight.ts` is the whole reason the file exists.
final class HighlightTests: XCTestCase {
    func testTheSharedLanguageFixturesHold() throws {
        for testCase in try Fixtures.load().languageOf {
            XCTAssertEqual(languageOf(testCase.name).rawValue, testCase.language, testCase.name)
        }
    }

    func testTheSharedHighlightFixturesHold() throws {
        for testCase in try Fixtures.load().highlight {
            let expected = testCase.runs.compactMap(\.run)
            XCTAssertEqual(
                expected.count,
                testCase.runs.count,
                "\(testCase.name): the fixture names a role this code does not know"
            )
            XCTAssertEqual(highlight(testCase.code, language: testCase.language), expected, testCase.name)
        }
    }

    func testABlockOfRunsGivesBackEveryCharacterAndNeverTouchesItsOwnKind() {
        let code = "const a = 1 // one\n/* two */ \"three\" `four`\nif (a) { a += 0x1f }"
        let runs = highlight(code, language: "ts")
        XCTAssertEqual(runs.map(\.text).joined(), code)
        for index in 1..<runs.count {
            XCTAssertNotEqual(runs[index].role, runs[index - 1].role, code)
        }
    }
}

private struct RunCase: Decodable {
    let role: String
    let text: String

    /// The run as the code builds it, or nil for a role the fixture names and it does not.
    var run: CodeRun? {
        CodeRole(rawValue: role).map { CodeRun(role: $0, text: text) }
    }
}

private struct HighlightCase: Decodable {
    let name: String
    let language: String?
    let code: String
    let runs: [RunCase]
}

private struct NameCase: Decodable {
    let name: String
    let language: String
}

private struct Fixtures: Decodable {
    let languageOf: [NameCase]
    let highlight: [HighlightCase]

    /// The one file both languages read, found from this source's own path so the package
    /// does not carry a second copy of it.
    static func load() throws -> Fixtures {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("test/fixtures/highlight.json")
        return try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: url))
    }
}
