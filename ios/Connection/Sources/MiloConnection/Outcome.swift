import Foundation

/**
 How a socket that ended reads, decided from the two things a transport can know: the
 response it got, and the error it failed with.

 A daemon that answered has judged this device; a daemon that never answered is only
 absent. Saying the two the same way is what made a phone that had simply outlived its
 daemon tell its owner to pair again — costing a token and teaching nothing. Neither
 is an outage to hide, so both are named.
 */
public enum Outcome: Equatable, Sendable {
    /// Nobody answered at all.
    case unreachable
    /// The daemon answered, and will not take this device.
    case refused(String)
}

public enum OutcomeDecision {
    /**
     What a dead socket was.

     - Parameters:
       - httpStatus: the response's status, when there was a response at all.
       - urlError: the transport's own error code, when it failed rather than answered.
     */
    public static func decide(httpStatus: Int?, urlError: URLError.Code?) -> Outcome {
        // `401` on the upgrade is how the daemon turns away a token it does not know —
        // there is no frame to carry the news, because there is no socket yet. Any
        // other status is a daemon that answered and refused too.
        if let status = httpStatus, status >= 400 {
            return .refused("The daemon did not accept this device (HTTP \(status)). Pair again for a new token.")
        }
        // A response that was not an upgrade: it answered, but its reason did not
        // survive the trip.
        if urlError == .badServerResponse {
            return .refused("The daemon answered but did not accept this device. Pair again for a new token.")
        }
        return .unreachable
    }
}
