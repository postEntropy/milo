import XCTest
@testable import MiloGenUi

/// The cases on disk, read by the browser's test too. A case this side computes
/// differently from `evaluate.ts` is the whole reason the file exists.
final class EvaluateTests: XCTestCase {
    func testTheSharedFormulaFixturesHold() throws {
        for testCase in try Fixtures.load().formula {
            XCTAssertEqual(
                evaluateFormula(testCase.formula, testCase.values),
                testCase.expected,
                "\(testCase.name): \(testCase.formula)"
            )
        }
    }

    func testTheSharedTemplateFixturesHold() throws {
        for testCase in try Fixtures.load().template {
            XCTAssertEqual(interpolate(testCase.text, testCase.values), testCase.expected, testCase.name)
        }
    }

    func testANumberKeepsAWholeNumberWholeAndTheRestAtThePlacesAskedFor() {
        XCTAssertEqual(formatNumber(232), "232")
        XCTAssertEqual(formatNumber(12.345, decimals: 0), "12")
        // The decimal mark follows the machine's locale, as `toLocaleString` does in
        // the browser, so either spelling is the right one on the surface that drew it.
        // The places themselves are ours: two digits, trailing zero filled in.
        XCTAssertTrue(["12.50", "12,50"].contains(formatNumber(12.5)))
    }
}

private struct FormulaCase: Decodable {
    let name: String
    let formula: String
    let values: GenUiValues
    let expected: Double?
}

private struct TemplateCase: Decodable {
    let name: String
    let text: String
    let values: GenUiValues
    let expected: String
}

private struct Fixtures: Decodable {
    let formula: [FormulaCase]
    let template: [TemplateCase]

    /// The one file both languages read, found from this source's own path so the
    /// package does not carry a second copy of it.
    static func load() throws -> Fixtures {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("test/fixtures/genui-evaluate.json")
        return try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: url))
    }
}

/// A fixture value is written as bare JSON: a number, a string or a boolean, the
/// same three a widget input holds.
extension GenUiValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let flag = try? container.decode(Bool.self) {
            self = .flag(flag)
            return
        }
        if let number = try? container.decode(Double.self) {
            self = .number(number)
            return
        }
        self = .text(try container.decode(String.self))
    }
}
