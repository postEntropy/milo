import XCTest
@testable import MiloConnection

final class OutcomeTests: XCTestCase {
    func testATokenTheDaemonWillNotTakeReadsAsARefusalNamingTheStatus() {
        let outcome = OutcomeDecision.decide(httpStatus: 401, urlError: nil)

        XCTAssertEqual(
            outcome,
            .refused("The daemon did not accept this device (HTTP 401). Pair again for a new token.")
        )
    }

    func testAnyStatusTheDaemonAnsweredWithIsARefusal() {
        XCTAssertEqual(
            OutcomeDecision.decide(httpStatus: 500, urlError: nil),
            .refused("The daemon did not accept this device (HTTP 500). Pair again for a new token.")
        )
    }

    func testAResponseThatWasNotAnUpgradeIsARefusalEvenWithoutAStatus() {
        // A `URLSessionWebSocketTask` need not hand back the response it refused.
        XCTAssertEqual(
            OutcomeDecision.decide(httpStatus: nil, urlError: .badServerResponse),
            .refused("The daemon answered but did not accept this device. Pair again for a new token.")
        )
    }

    func testADAemonThatIsNotThereIsNotARefusal() {
        // The whole point: an absent daemon must never be said in the words that mean
        // this device was turned away.
        XCTAssertEqual(OutcomeDecision.decide(httpStatus: nil, urlError: .cannotConnectToHost), .unreachable)
        XCTAssertEqual(OutcomeDecision.decide(httpStatus: nil, urlError: .timedOut), .unreachable)
        XCTAssertEqual(OutcomeDecision.decide(httpStatus: nil, urlError: .networkConnectionLost), .unreachable)
        XCTAssertEqual(OutcomeDecision.decide(httpStatus: nil, urlError: .notConnectedToInternet), .unreachable)
    }

    func testNoWordsAtAllIsUnreachable() {
        XCTAssertEqual(OutcomeDecision.decide(httpStatus: nil, urlError: nil), .unreachable)
    }
}
