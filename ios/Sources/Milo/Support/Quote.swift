/// The words a person picked out of an answer, as they lead the reply to it: every line
/// quoted, then the blank line that separates them from what is said back.
///
/// `quotedLead` in `src/core/sessions/format.ts` is the same rule on the browser side. The
/// two surfaces have no runtime in common, so this is the phone's own reading of it and
/// this line is what keeps the two recognisable as one thing.
func quotedLead(_ words: String) -> String {
    let quoted = words
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { "> \($0)" }
        .joined(separator: "\n")
    return "\(quoted)\n\n"
}
