import SwiftUI

/// The panel a composer control has raised: what belongs to the message being written, or
/// what a running turn answers to. One at a time, and never in place of the composer.
enum ComposerMenu: Equatable {
    case actions
    case running
}

/// The composer is a filled capsule that floats and stays put: the field grows with what is
/// typed, on one row in an ordinary chat and with the controls under it in a work session —
/// see `work`.
struct Composer: View {
    @Binding var draft: String
    /// The words picked out of an answer, held until the reply is sent.
    @Binding var quote: String?
    /// The files picked and not yet sent, held until the reply is sent with them. They are
    /// picked from the panel this composer's own control raises, and drawn above the field.
    @Binding var drafts: [AttachmentDraft]
    /// The turn an edit forks at, when the draft is an edit rather than a new message.
    @Binding var editing: Int?
    @FocusState.Binding var focused: Bool
    /// The panel this composer's controls raise, held by the screen: the panel is drawn over
    /// the composer — above the layer that dismisses it — rather than inside it.
    @Binding var menu: ComposerMenu?
    /// Sending, wherever it is asked for. The field's own control and the lines of the panel
    /// the send control raises are one action, so they are one function, on the screen.
    let send: (ClientFrame.Intent) -> Void
    /// Whether this session works in a project, which is what makes the composer two lines:
    /// the work surface keeps the model on the bar, an ordinary chat keeps it in the panel.
    let work: Bool
    /// Which composer this is: the one the open session is spoken into, or the one a project's
    /// own page carries, where the words being written are what starts a session.
    ///
    /// The second has no thread behind it yet, so none of the open session's own state belongs
    /// to it — not the queued count, not the job strip, not the control a running turn answers
    /// to, and not the `+`: a session not yet begun has nothing for a file to belong to. The
    /// model stays, because it is what the message about to be sent will run on.
    enum Role { case session, start }

    var role: Role = .session
    /// Raising the model picker. The model is the composer's own line, so choosing one is the
    /// composer's own action — the screen owns the sheet, as it owns the `+` panel.
    let onModel: () -> Void
    @Environment(AppModel.self) private var model
    /// Whether the send control is under a finger, for the give every filled control here has.
    /// A control driven by gestures rather than by a `Button` — the long press the panel hangs
    /// on — has to ask for that itself.
    @State private var pressed = false

    var body: some View {
        VStack(spacing: MiloTheme.Space.two) {
            if role == .session, model.queued > 0 {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "clock.arrow.circlepath")
                    Text(model.queued == 1 ? "1 message queued" : "\(model.queued) messages queued")
                    Spacer(minLength: 0)
                }
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
                .padding(.horizontal, MiloTheme.Space.six + MiloTheme.Space.four)
            }

            // The background jobs still running, above the field and below the queued
            // count — the browser's own order. Nothing of the strip is drawn at rest.
            if role == .session, !model.jobs.isEmpty {
                JobStrip(jobs: model.jobs)
            }

            if let quote {
                quoteStrip(quote)
                    .padding(.horizontal, MiloTheme.margin)
            }

            // The files, above the field they will be sent with: the same place the
            // quotation takes, so both read as part of the message being written.
            if !drafts.isEmpty {
                DraftStrip(drafts: drafts) { draft in
                    drafts.removeAll { $0.id == draft.id }
                }
            }

            // One capsule, two arrangements, and the surface is one in either: what is
            // written, and what it is written with.
            //
            // A work session gives the field a line of its own and drops the controls under
            // it, the chosen model among them — read there without opening anything, which is
            // what the model is on a surface meant for looking at the work. An ordinary chat
            // keeps the controls on the field's own line, where the model is a line of the
            // `+` panel instead. One composer, placed two ways.
            VStack(spacing: MiloTheme.Space.one) {
                if work {
                    field
                        .padding(.leading, MiloTheme.Space.two + Self.markLead)
                        .padding(.trailing, MiloTheme.Space.two)
                    workRow
                } else {
                    // Centred against the field: the send control is shorter than a line of
                    // text, so bottom-aligning it left the air above it and read as a bump.
                    HStack(alignment: .center, spacing: MiloTheme.Space.one) {
                        if role == .session { actionsButton }
                        field
                        sendControl
                    }
                    .padding(.horizontal, MiloTheme.Space.two)
                }
            }
            // A little air above and below the rows, so the send control does not read as
            // the composer's whole height — the capsule stands taller than what it holds.
            .padding(.vertical, MiloTheme.Space.one)
            .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26))
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .padding(.top, MiloTheme.Space.one)
        }
    }

    /// What the `+`'s own mark takes: the size it is drawn at, inside the wider box the
    /// finger gets. Half of the difference is where that mark's left edge sits, and the
    /// field's text starts on that line — so the two rows of a work composer read as one
    /// column instead of the words hanging off the left of the control below them.
    private static let mark: CGFloat = 20
    private static let markLead: CGFloat = (40 - mark) / 2

    /// The field itself, the same one in either arrangement: the two composers are one
    /// composer placed two ways, so what is typed is typed in one field.
    private var field: some View {
        TextField("Ask Milo anything", text: $draft, axis: .vertical)
            .lineLimit(1...8)
            .focused($focused)
            .font(.body)
            .foregroundStyle(MiloTheme.foreground)
            .padding(.vertical, MiloTheme.Space.two + 2)
    }

    /// The `+`, raising the panel of what belongs to the message.
    ///
    /// It raises the panel rather than opening a menu of the platform's: a platform menu
    /// takes the shape of the control it came from as it opens, and a control inside the
    /// composer then reads as the composer becoming the menu.
    private var actionsButton: some View {
        Button {
            menu = menu == .actions ? nil : .actions
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(MiloTheme.foreground)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("More")
        // The choices are the settings screen's own read, so this asks for them once when
        // it does not have them — one reader, two places that show it.
        .onAppear {
            if model.efforts.isEmpty { Task { await model.loadSettings() } }
        }
    }

    /// The way to send, or the control a running turn answers to. The same span as the `+`
    /// opposite it, with no padding of its own: two controls on one row line up because they
    /// are the same height, not because each was nudged to look like the other.
    @ViewBuilder private var sendControl: some View {
        if role == .session, model.busy {
            // While a turn runs the same control sends or stops, and what is in the field
            // decides which — see `busyControl`. One control, never a second one standing
            // beside it.
            busyControl
        } else {
            MiloIconButton(
                systemName: "paperplane.fill",
                size: 16,
                span: 36,
                primary: true,
                disabled: !canSend,
                action: { send(.queue) }
            )
            .accessibilityLabel("Send")
        }
    }

    /// A work session's second line: the files, the chosen model, and the way to send.
    private var workRow: some View {
        HStack(spacing: MiloTheme.Space.one) {
            if role == .session { actionsButton }
            modelPill
            Spacer(minLength: MiloTheme.Space.two)
            sendControl
        }
        .padding(.horizontal, MiloTheme.Space.two)
    }

    /// What this message is written with, on the work session's own line. Filled like every
    /// control here, so it reads as something to press — and it says what is chosen now,
    /// rather than making a setting something to go looking for.
    private var modelPill: some View {
        Button(action: onModel) {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "cpu")
                        .font(.system(size: 12, weight: .semibold))
                    Text(model.modelLabel.isEmpty ? "Model" : model.modelLabel)
                        .font(MiloTheme.Text.small)
                        .lineLimit(1)
                        .truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(MiloTheme.foreground2)
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.vertical, MiloTheme.Space.two + 1)
            .background(Capsule().fill(MiloTheme.surface))
            .contentShape(Capsule())
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Model")
        .accessibilityValue(model.modelLabel)
    }

    /// What is being answered, held at the composer until the reply is sent: the words
    /// picked out, and the way to drop them. The browser keeps the same strip above its own
    /// field, and both take the same shape on the wire — see `quotedLead`.
    ///
    /// It wears the platform's own glass, the material the composer below it is made of:
    /// the faint tint it carried before barely showed against the page, so the strip
    /// vanished instead of standing over the thread it was picked from.
    private func quoteStrip(_ words: String) -> some View {
        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
            Image(systemName: "quote.opening")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.accent)
            Text(words)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.foreground2)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                quote = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.muted)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Remove quote")
        }
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.vertical, MiloTheme.Space.two)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
    }

    private var canSend: Bool {
        !drafts.isEmpty || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// While a turn runs the field's own text decides this control. Empty, it stops: a tap
    /// ends the turn, and there is nothing typed that wants sending. With words in it, the
    /// tap sends them as a **steer** — the correction the browser puts on Ctrl/Cmd+Enter,
    /// which on a phone with no keys is the plain tap — and the press held down raises the
    /// panel naming all three things a running turn answers to, so neither queuing nor
    /// stopping nor the steering the tap already does is left for the reader to guess.
    /// Stopping never needs the field cleared first. A deliberate divergence from the
    /// browser, whose tap stays stop and whose plain Enter queues.
    ///
    /// Gestures rather than a button, so the platform tells the tap and the hold apart: a
    /// button answers the finger lifting after a hold as well as the hold itself, and
    /// steering on the way into the panel is not what a long press is asking for.
    @ViewBuilder
    private var busyControl: some View {
        if canSend {
            steerGlyph
                .contentShape(Circle())
                // A lift that came after a hold is the hold's, not a steer: with the panel
                // already up, the tap has nothing to send.
                .onTapGesture { if menu == nil { send(.steer) } }
                .onLongPressGesture(pressing: { pressing in
                    pressed = pressing
                }) {
                    menu = .running
                }
                .scaleEffect(pressed ? 0.97 : 1)
                .opacity(pressed ? 0.85 : 1)
                .animation(.snappy(duration: 0.18), value: pressed)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("Steer")
        } else {
            Button(action: model.stop) { stopGlyph }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Stop")
        }
    }

    /// The way to send, wearing what it does: the filled accent the idle send wears, so it
    /// is still read as the way to send, but the turn arrow says the tap steers the running
    /// turn rather than opening a new one — the same mark the panel names that line with.
    private var steerGlyph: some View {
        Image(systemName: "arrow.turn.down.right")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(MiloTheme.accentOn)
            .frame(width: 36, height: 36)
            .background(Circle().fill(MiloTheme.accent))
    }

    /// A quiet fill — the accent stays on the one thing to press when nothing runs.
    private var stopGlyph: some View {
        Image(systemName: "stop.fill")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(MiloTheme.foreground)
            .frame(width: 36, height: 36)
            .background(Circle().fill(MiloTheme.surface))
    }
}

/// The background jobs still running, in a strip above the composer — the browser's own,
/// drawn from the same `jobs` frame. A job is one glass chip: what it is running, how long
/// it has been going, and the tail of what it has printed, folded until a tap opens it; the
/// control beside the chip stops it. Only running jobs are ever in the list, so an ended one
/// leaves the strip on its own.
struct JobStrip: View {
    let jobs: [JobView]
    @Environment(AppModel.self) private var model
    /// The job whose output is open, by id — one at a time, as the browser keeps it.
    @State private var open: String?

    var body: some View {
        // A clock only while a job is on screen: the elapsed counter has to move, and a
        // timer left running under an empty strip would wake the screen for nothing.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(spacing: MiloTheme.Space.two) {
                ForEach(jobs) { job in
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        chip(job, now: context.date.timeIntervalSince1970)
                        if open == job.id { log(job) }
                    }
                }
            }
        }
        .padding(.horizontal, MiloTheme.margin)
    }

    private func chip(_ job: JobView, now: Double) -> some View {
        HStack(spacing: MiloTheme.Space.two) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { open = open == job.id ? nil : job.id }
            } label: {
                HStack(spacing: MiloTheme.Space.two) {
                    Image(systemName: "terminal")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(MiloTheme.muted)
                    Text(Self.oneLine(job.command))
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.foreground2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: MiloTheme.Space.two)
                    Text(RelativeTime.elapsed(max(0, now - job.startedAt)))
                        .font(MiloTheme.Text.meta)
                        .foregroundStyle(MiloTheme.muted)
                        .monospacedDigit()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MiloTheme.muted)
                        .rotationEffect(.degrees(open == job.id ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(open == job.id ? "Hide the job's output" : "Show the job's output")

            // Filled, not outlined: the chip is the surface and this is the one control on
            // it. Pressing it is the confirmation the wire wants.
            Button { model.killJob(job.id) } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(MiloTheme.surface))
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("Stop this job")
        }
        .padding(.leading, MiloTheme.Space.four)
        .padding(.trailing, MiloTheme.Space.two)
        .padding(.vertical, MiloTheme.Space.two)
        .glassEffect(.regular, in: Capsule())
    }

    private func log(_ job: JobView) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(job.lines.isEmpty ? "No output yet." : job.lines.joined(separator: "\n"))
                .font(MiloTheme.Text.mono)
                .foregroundStyle(MiloTheme.foreground2)
                .textSelection(.enabled)
                .padding(MiloTheme.Space.three)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
        .marksScrollBox()
    }

    /// The command on one line: the browser's own `oneLine` clips at eighty characters, so
    /// a long command cannot take the strip's height.
    private static func oneLine(_ command: String) -> String {
        String(command.replacingOccurrences(of: "\n", with: " ").prefix(80))
    }
}

/// The confirmation a tool call needs, waiting where the reply would land.
struct PermissionBar: View {
    let pending: (id: String, request: PermissionRequest, expiresAt: Double)
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text(pending.request.summary)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.foreground2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: MiloTheme.Space.three) {
                // The platform's own glass, as every control here is made. The browser's own
                // pair is solid, and that is the browser's house: its surfaces are tokens, and
                // this app's are the platform's material.
                MiloWideButton(title: "Deny") { model.answerPermission(allowed: false) }
                MiloWideButton(title: "Allow", primary: true) { model.answerPermission(allowed: true) }
            }
            // The daemon lets a prompt expire; the countdown says how long it holds.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Label(remaining(at: context.date), systemImage: "clock")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            }
        }
        .padding(MiloTheme.Space.four)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .padding(.horizontal, MiloTheme.Space.three)
    }

    private func remaining(at now: Date) -> String {
        let left = max(0, Int((pending.expiresAt / 1000 - now.timeIntervalSince1970).rounded(.up)))
        return String(format: "%d:%02d", left / 60, left % 60)
    }
}
