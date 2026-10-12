import SwiftUI

/// The session on screen: a floating top bar, the thread, and a floating
/// composer pinned above the keyboard. No rules between the regions — each is
/// carried by its own surface and spacing.
struct ChatView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var drawer = false
    @State private var picker = false
    @State private var settings = false
    @FocusState private var composing: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            // Behind: the sessions. The chat sits on top and slides aside to show
            // them, as the ChatGPT app does. The sessions are only drawn while
            // they are open — and until the chat has slid back over them — so
            // nothing of the sidebar can show through the chat at rest.
            SessionsDrawer(onClose: { drawer = false }, onSettings: {
                drawer = false
                settings = true
            })
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .opacity(drawer ? 1 : 0)
                .animation(drawer ? nil : .linear(duration: 0.01).delay(Self.drawerDuration), value: drawer)
                .allowsHitTesting(drawer)
                .accessibilityHidden(!drawer)

            chat
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The card is the background: it runs under the status bar and the
                // home indicator, and carries the rounded edge and the shadow while
                // the content stays inside the safe area.
                .background {
                    UnevenRoundedRectangle(
                        topLeadingRadius: drawer ? 28 : 0,
                        bottomLeadingRadius: drawer ? 28 : 0
                    )
                    .fill(MiloTheme.background)
                    .shadow(color: .black.opacity(drawer ? 0.18 : 0), radius: 14, x: -2, y: 0)
                    .ignoresSafeArea()
                }
                .offset(x: drawer ? Self.drawerWidth : 0)
                // While the sessions are open, the chat is a lid: a tap anywhere
                // on it closes them instead of reaching what is underneath.
                .overlay {
                    if drawer {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { drawer = false }
                    }
                }

        }
        .animation(.smooth(duration: Self.drawerDuration), value: drawer)
        .sensoryFeedback(.impact(weight: .light), trigger: drawer)
        // The two edges of an answer: a firmer tap when the daemon begins to
        // speak, a softer one when it lands. `busy` cannot be the trigger — it
        // goes up on the send, before the daemon has said anything, so the tap
        // would land on the person's own thumb.
        .sensoryFeedback(.impact(weight: .medium, intensity: 0.6), trigger: model.answerBegan)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.5), trigger: model.answerEnded)
        // A swipe right from anywhere opens the sessions and a swipe back closes them — the
        // gesture the platform's own sidebars answer to. Only a mostly horizontal
        // drag counts, so scrolling the thread is never mistaken for it.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { drag in
                    let across = drag.translation.width
                    guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                    if !drawer, across > 60 {
                        openDrawer()
                    } else if drawer, across < -60 {
                        drawer = false
                    }
                }
        )
        .task {
            composing = true
            await model.begin(at: account)
            await model.refreshSessions()
        }
        .sheet(isPresented: $picker) { ModelPickerSheet() }
        .sheet(isPresented: $settings) { SettingsView(account: account) }
    }

    private static let drawerWidth: CGFloat = 300
    /// The slide of the chat uncovering the sessions. One value for the move and for
    /// the moment the list under it comes back, so the two cannot drift apart.
    private static let drawerDuration: Double = 0.28

    /// Opening the sessions is leaving the thread: the keys go down with it rather
    /// than sitting under a list that has nothing to type into.
    private func openDrawer() {
        composing = false
        drawer = true
    }

    private var chat: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if model.messages.isEmpty { WelcomeView() }
                ForEach(model.messages) { message in
                    MessageRow(message: message)
                }
            }
            .padding(.horizontal, MiloTheme.Space.four)
            .padding(.vertical, MiloTheme.Space.four)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .safeAreaInset(edge: .top, spacing: 0) { topbar }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottom }

    }

    private var topbar: some View {
        VStack(spacing: MiloTheme.Space.one) {
            HStack(spacing: MiloTheme.Space.three) {
                // The platform's own glass button: it takes the tap itself, so the
                // swipe on the screen cannot swallow it.
                Button { openDrawer() } label: {
                    Image(systemName: "line.3.horizontal")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .controlSize(.regular)
                .accessibilityLabel("Sessions")

                Spacer(minLength: MiloTheme.Space.two)
            }
            .overlay {
                if let title = model.title {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.horizontal, 64)
                }
            }
            if let state = statusLine {
                Text(state)
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.danger)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, MiloTheme.Space.four)
        .padding(.bottom, MiloTheme.Space.two)
    }

    /// Nothing is said while the socket is up: a state line is only worth its
    /// pixels when it is not the normal one. The words come from the state itself,
    /// so a state added there cannot go unworded here.
    private var statusLine: String? {
        switch model.connection {
        case .online, .idle: return nil
        default: return model.connection.wording
        }
    }

    private var bottom: some View {
        VStack(spacing: MiloTheme.Space.two) {
            if let note = model.note {
                Text(note)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, MiloTheme.Space.five)
            }
            if let pending = model.pending {
                PermissionBar(pending: pending)
            }
            Composer(draft: $draft, focused: $composing, openPicker: { picker = true })
        }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
            Text("What's on your mind?")
                .font(.title3.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Text("This is the same session the browser and the terminal see.")
                .font(MiloTheme.Text.base)
                .foregroundStyle(MiloTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, MiloTheme.Space.six)
    }
}

/// The composer is a filled capsule that floats and stays put: the field grows
/// with what is typed, on a single row between the model menu and the way to send.
struct Composer: View {
    @Binding var draft: String
    @FocusState.Binding var focused: Bool
    let openPicker: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(alignment: .bottom, spacing: MiloTheme.Space.one) {
            // The model lives behind this, not on the bar: what belongs to the
            // message is the field and the way to send it.
            Menu {
                Button { openPicker() } label: { Label("Model", systemImage: "cpu") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
            }
            .accessibilityLabel("More")

            TextField("Ask Milo anything", text: $draft, axis: .vertical)
                .lineLimit(1...8)
                .focused($focused)
                .font(.body)
                .foregroundStyle(MiloTheme.foreground)
                .padding(.vertical, MiloTheme.Space.two + 2)

            // The same span as the `+` opposite it, with no padding of its own: two
            // controls on one row line up because they are the same height, not
            // because each was nudged to look like the other.
            MiloIconButton(
                systemName: model.busy ? "stop.fill" : "paperplane.fill",
                size: 16,
                span: 40,
                primary: true,
                disabled: !model.busy && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                action: send
            )
            .accessibilityLabel(model.busy ? "Stop" : "Send")
        }
        .padding(.horizontal, MiloTheme.Space.two)
        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, MiloTheme.Space.three)
        .padding(.bottom, MiloTheme.Space.two)
        .padding(.top, MiloTheme.Space.two)
    }


    private func send() {
        if model.busy {
            model.stop()
            return
        }
        model.send(draft)
        draft = ""
        // The next message is typed where the last one was, not on the button.
        focused = true
    }
}

struct MessageRow: View {
    let message: AppModel.Message
    @State private var showReasoning = false

    var body: some View {
        if message.isUser {
            HStack {
                Spacer(minLength: 48)
                Text(prose)
                    .font(.body)
                    .foregroundStyle(MiloTheme.foreground)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.vertical, MiloTheme.Space.three)
                    .background(MiloTheme.surfaceWarm, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            }
            .contextMenu { copyButton }
        } else {
            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                if let thought = message.thought {
                    Button {
                        withAnimation(.easeInOut(duration: 0.22)) { showReasoning.toggle() }
                    } label: {
                        Text("Thought for \(Int(thought.rounded()))s")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                if showReasoning {
                    ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                        if case .reasoning(let text) = part {
                            Text(text)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                                .textSelection(.enabled)
                        }
                    }
                }
                ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                    switch part {
                    case .reasoning:
                        EmptyView()
                    default:
                        PartView(part: part)
                    }
                }
                if message.streaming, !message.parts.contains(where: { part in
                    if case .text = part { return true }
                    return false
                }) {
                    WaitLine()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu { copyButton }
        }
    }

    @ViewBuilder
    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = prose
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
    }

    private var prose: String {
        message.parts
            .compactMap { part in
                if case .text(let text) = part { return text }
                return nil
            }
            .joined(separator: "\n\n")
    }
}

struct PartView: View {
    let part: WirePart

    var body: some View {
        switch part {
        case .text(let text):
            Text(text)
                .font(.body)
                .foregroundStyle(MiloTheme.foreground)
                .textSelection(.enabled)
        case .tool(let tool):
            ToolRow(tool: tool)
        case .todo(let items):
            TodoRow(items: items)
        case .reasoning, .other:
            EmptyView()
        }
    }
}

/// One tool call: the state is the dot, the name is the line.
struct ToolRow: View {
    let tool: ToolMark

    var body: some View {
        HStack(spacing: MiloTheme.Space.two) {
            Circle().fill(dot).frame(width: 6, height: 6)
            Text(tool.text.isEmpty ? tool.name : tool.text)
                .font(MiloTheme.Text.mono)
                .foregroundStyle(tool.state == "failed" ? MiloTheme.danger : MiloTheme.muted)
                .lineLimit(1)
                .truncationMode(.middle)
            if tool.state == "failed" {
                Text("failed").font(MiloTheme.Text.meta).foregroundStyle(MiloTheme.danger)
            }
        }
    }

    private var dot: Color {
        switch tool.state {
        case "running": return MiloTheme.accent
        case "failed": return MiloTheme.danger
        default: return MiloTheme.success
        }
    }
}

struct TodoRow: View {
    let items: [TodoItem]

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: MiloTheme.Space.two) {
                    Text(item.mark).font(MiloTheme.Text.mono).foregroundStyle(mark(item.status))
                    Text(item.content)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(item.status == "completed" ? MiloTheme.muted : MiloTheme.foreground2)
                        .strikethrough(item.status == "completed", color: MiloTheme.muted)
                }
            }
        }
        .padding(MiloTheme.Space.three)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
    }

    private func mark(_ status: String) -> Color {
        switch status {
        case "completed": return MiloTheme.success
        case "in_progress": return MiloTheme.accent
        default: return MiloTheme.muted
        }
    }
}

/// The confirmation a tool call needs, waiting where the reply would land.
struct PermissionBar: View {
    let pending: (id: String, request: PermissionRequest)
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text(pending.request.summary)
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.foreground2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: MiloTheme.Space.three) {
                Button { model.answerPermission(allowed: false) } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .controlSize(.large)

                Button { model.answerPermission(allowed: true) } label: {
                    Text("Allow").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
            }
        }
        .padding(MiloTheme.Space.four)
        .glassEffect(in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .padding(.horizontal, MiloTheme.Space.three)
    }
}
