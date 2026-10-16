import XCTest
@testable import MiloConnection

final class PairProbeTests: XCTestCase {
    func testAFrameFromTheDaemonMeansTheSocketOpened() {
        // The whole point of the probe: a socket that spoke back is the one proof a
        // pair can connect, whatever the claim said before it.
        XCTAssertEqual(
            PairProbe.decide(everOnline: true, refusal: nil, httpStatus: nil, urlError: nil),
            .online
        )
    }

    func testTheDaemonsOwnRefusalWinsOverEverything() {
        // An `error` frame is the daemon answering, so it is the verdict — even if the
        // socket later dropped with no status of its own.
        XCTAssertEqual(
            PairProbe.decide(
                everOnline: false,
                refusal: "The daemon did not accept this device (HTTP 401). Pair again for a new token.",
                httpStatus: nil,
                urlError: .networkConnectionLost
            ),
            .refused("The daemon did not accept this device (HTTP 401). Pair again for a new token.")
        )
    }

    func testAnUpgradeRefusedWithAStatusIsARefusalInTheSameWords() {
        XCTAssertEqual(
            PairProbe.decide(everOnline: false, refusal: nil, httpStatus: 401, urlError: nil),
            .refused("The daemon did not accept this device (HTTP 401). Pair again for a new token.")
        )
    }

    func testADAemonThatNeverAnsweredIsNotARefusal() {
        // A daemon that was not there, or a path that swallowed the upgrade, must not be
        // said in the words that mean this device was turned away.
        XCTAssertEqual(
            PairProbe.decide(everOnline: false, refusal: nil, httpStatus: nil, urlError: .timedOut),
            .noSocket
        )
        XCTAssertEqual(
            PairProbe.decide(everOnline: false, refusal: nil, httpStatus: nil, urlError: .cannotConnectToHost),
            .noSocket
        )
    }

    func testNothingAtAllIsNoSocket() {
        XCTAssertEqual(
            PairProbe.decide(everOnline: false, refusal: nil, httpStatus: nil, urlError: nil),
            .noSocket
        )
    }
}
