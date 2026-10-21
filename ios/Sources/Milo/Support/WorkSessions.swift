import Foundation

/// Whether a session is work. It is the project it names that decides — not the presence of
/// an id: a project removed from the list leaves its sessions bound to an id nothing answers
/// to any more, and those are sessions with no project to be in. Counting them as work would
/// take them out of both lists, which is a session disappearing.
///
/// Until the projects have been read once, anything naming one is treated as work: it may be,
/// and showing it under the wrong roof is worse than a beat of nothing.
func isWorkSession(_ session: SessionSummary, projects: [Project], read: Bool) -> Bool {
    guard session.project != nil else { return false }
    guard read else { return true }
    return projects.contains { $0.id == session.project }
}

/// What a session is found by: the words on its row and its id — the browser's own fields,
/// so the same query finds the same rows on both surfaces.
func sessionMatches(_ session: SessionSummary, query: String) -> Bool {
    "\(session.title ?? "") \(session.preview) \(session.id)".lowercased().contains(query)
}

/// The newest few of a project's sessions, plus any still running or still unread: work in
/// flight and work waiting to be read are never hidden behind a count, however long either
/// has been going. The index and the drawer draw their rows from this, so they cannot cut
/// the same list differently.
func inlineWorkSessions(_ sessions: [SessionSummary], limit: Int = 3) -> [SessionSummary] {
    let newest = sessions.sorted { $0.updatedAt > $1.updatedAt }
    let shown = Array(newest.prefix(limit))
    let waiting = newest.dropFirst(limit).filter { $0.running == true || $0.unread == true }
    return (shown + waiting).sorted { $0.updatedAt > $1.updatedAt }
}
