import SwiftUI

/// Hub and pinned-tab Memory surface, matching the workspace glass-card design language.
struct MemoryView: View {
    let embeddedInHub: Bool
    let onOpenSession: (String) -> Void

    @Environment(AppModel.self) private var model
    @State private var recallLimitText = ""
    @State private var noteQuery = ""
    @State private var noteOffset = 0
    @State private var editingNote: MemoryNote?
    @State private var noteText = ""
    @FocusState private var recallFocused: Bool

    var body: some View {
        Group {
            if embeddedInHub {
                content
            } else {
                NavigationStack {
                    content
                }
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                heroCard

                if let error = model.settingsError {
                    MiloErrorPill(text: error)
                }

                notesSection
                recallSection
                embeddingSection
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .miloWallpaperBackground()
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.connectionLine != nil {
                ConnectionPill()
                    .padding(.horizontal, MiloTheme.margin)
                    .padding(.bottom, MiloTheme.Space.two)
                    .animation(.smooth(duration: 0.22), value: model.connectionLine)
            }
        }
        .toolbar(embeddedInHub ? .visible : .hidden, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    recallFocused = false
                    commitRecallLimit()
                }
            }
        }
        .refreshable {
            await model.loadSettings()
            await model.loadMemoryNotes(query: noteQuery, offset: noteOffset)
        }
        .onAppear {
            recallLimitText = model.memoryRecallLimit.map(String.init) ?? ""
        }
        .onChange(of: model.memoryRecallLimit) { _, next in
            if !recallFocused {
                recallLimitText = next.map(String.init) ?? ""
            }
        }
        .onChange(of: recallFocused) { _, focused in
            if !focused { commitRecallLimit() }
        }
        .task(id: model.accountDisplay) {
            await model.ensureSettingsLoaded()
        }
        .task(id: "\(model.accountDisplay)\u{0}\(noteQuery)\u{0}\(noteOffset)") {
            await model.loadMemoryNotes(query: noteQuery, offset: noteOffset)
        }
        .onChange(of: model.onlineEpoch) { _, _ in
            Task {
                await model.loadSettings()
                await model.loadMemoryNotes(query: noteQuery, offset: noteOffset)
            }
        }
        .alert("Edit note", isPresented: Binding(get: { editingNote != nil }, set: { if !$0 { editingNote = nil } })) {
            TextField("Note", text: $noteText)
            Button("Cancel", role: .cancel) { editingNote = nil }
            Button("Save") {
                guard let note = editingNote else { return }
                Task {
                    if await model.updateMemoryNote(note.id, text: noteText) {
                        editingNote = nil
                        await model.loadMemoryNotes(query: noteQuery, offset: noteOffset)
                    }
                }
            }
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "cylinder")
                    .font(.system(size: 13, weight: .semibold))
                Text("WORKSPACE")
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .tracking(1.1)
            }
            .foregroundStyle(MiloTheme.accent)

            Text("Memory")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(MiloTheme.foreground)

            Text("Facts Milo remembers across sessions, and how recall works.")
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.muted)

            HStack(spacing: MiloTheme.Space.two) {
                if let stats = model.memoryStats {
                    Text("\(stats.facts) \(stats.facts == 1 ? "note" : "notes")")
                        .foregroundStyle(MiloTheme.foreground)
                    Text("·").foregroundStyle(MiloTheme.muted)
                    Text(SettingsWording.bytes(stats.bytes))
                        .foregroundStyle(MiloTheme.muted)
                    Text("·").foregroundStyle(MiloTheme.muted)
                }
                Text(embeddingSummary)
                    .foregroundStyle(MiloTheme.muted)
            }
            .font(MiloTheme.Text.small.weight(.medium))
            .padding(.top, MiloTheme.Space.one)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.five)
        .miloGlassCard(radius: MiloTheme.Radius.xl)
    }

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Text("Notes")
                    .font(MiloTheme.Text.title)
                    .foregroundStyle(MiloTheme.foreground)
                Spacer(minLength: 0)
                if let stats = model.memoryStats {
                    Text(stats.location)
                        .font(MiloTheme.Text.meta.monospaced())
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }

            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "magnifyingglass")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                TextField("Search notes", text: $noteQuery)
                    .font(MiloTheme.Text.base)
                    .foregroundStyle(MiloTheme.foreground)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onChange(of: noteQuery) { _, _ in noteOffset = 0 }
                if !noteQuery.isEmpty {
                    Button {
                        noteQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, MiloTheme.Space.three)
            .padding(.vertical, MiloTheme.Space.three)
            .miloGlassCard(radius: MiloTheme.Radius.lg)

            if let notes = model.memoryNotes {
                if notes.isEmpty {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        Text(noteQuery.isEmpty ? "Nothing is remembered yet." : "No notes match your search.")
                            .font(MiloTheme.Text.body.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                        Text(noteQuery.isEmpty
                            ? "Facts saved automatically or asked of Milo will appear here."
                            : "Try a different keyword or clear the filter.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.four)
                    .miloGlassCard(radius: MiloTheme.Radius.lg)
                } else {
                    VStack(spacing: MiloTheme.Space.two) {
                        ForEach(notes) { note in
                            noteCard(note)
                        }
                    }
                }
            } else {
                HStack(spacing: MiloTheme.Space.two) {
                    ProgressView().controlSize(.small)
                    Text("Reading…")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                .padding(MiloTheme.Space.four)
                .frame(maxWidth: .infinity, alignment: .leading)
                .miloGlassCard(radius: MiloTheme.Radius.lg)
            }

            if noteOffset > 0 || model.memoryNotesMore {
                HStack(spacing: MiloTheme.Space.two) {
                    Button("Previous") {
                        noteOffset = max(0, noteOffset - 50)
                    }
                    .font(MiloTheme.Text.small.weight(.semibold))
                    .foregroundStyle(noteOffset == 0 ? MiloTheme.muted : MiloTheme.foreground)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.vertical, MiloTheme.Space.two)
                    .miloGlassCard(radius: MiloTheme.Radius.lg, interactive: noteOffset > 0)
                    .disabled(noteOffset == 0)

                    Spacer(minLength: 0)

                    Button("Next") {
                        noteOffset += 50
                    }
                    .font(MiloTheme.Text.small.weight(.semibold))
                    .foregroundStyle(!model.memoryNotesMore ? MiloTheme.muted : MiloTheme.foreground)
                    .padding(.horizontal, MiloTheme.Space.four)
                    .padding(.vertical, MiloTheme.Space.two)
                    .miloGlassCard(radius: MiloTheme.Radius.lg, interactive: model.memoryNotesMore)
                    .disabled(!model.memoryNotesMore)
                }
            }

            Text("Editing or forgetting a note does not erase past messages, which may still be recalled.")
                .font(MiloTheme.Text.meta)
                .foregroundStyle(MiloTheme.muted)
        }
    }

    private func noteCard(_ note: MemoryNote) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text(note.text)
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.foreground)
                .fixedSize(horizontal: false, vertical: true)

            if let source = note.source {
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    Text("Source: “\(source.quote)”")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(3)
                    Button {
                        onOpenSession(source.session)
                    } label: {
                        HStack(spacing: MiloTheme.Space.one + 2) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Open Session")
                                .font(MiloTheme.Text.small.weight(.semibold))
                        }
                        .foregroundStyle(MiloTheme.accentOn)
                        .padding(.horizontal, MiloTheme.Space.three)
                        .padding(.vertical, MiloTheme.Space.one + 2)
                        .background(MiloTheme.accent, in: Capsule())
                    }
                    .buttonStyle(PressableStyle())
                }
            } else {
                Text("Source unavailable")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
            }

            HStack(spacing: MiloTheme.Space.two) {
                Text("Last said \(RelativeTime.when(note.createdAt)) · \(String(note.id.prefix(8)))")
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
                Spacer(minLength: 0)
                MiloIconButton(systemName: "pencil", size: 14, span: 36, glass: true) {
                    noteText = note.text
                    editingNote = note
                }
                .accessibilityLabel("Edit note")
                .help("Edit note")
                MiloIconButton(systemName: "trash", size: 14, span: 36, glass: true) {
                    Task { await model.forgetMemoryNote(note.id) }
                }
                .accessibilityLabel("Forget note")
                .help("Forget note")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.four)
        .miloGlassCard(radius: MiloTheme.Radius.lg)
    }

    private var recallSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Recall")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                Toggle("Save facts automatically", isOn: derive)
                    .font(MiloTheme.Text.base.weight(.medium))
                    .foregroundStyle(MiloTheme.foreground)
                    .tint(MiloTheme.accent)

                HStack(spacing: MiloTheme.Space.two) {
                    Text("Notes used per reply")
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.foreground)
                    Spacer(minLength: 0)
                    TextField("Default", text: $recallLimitText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .focused($recallFocused)
                        .font(MiloTheme.Text.base.monospacedDigit())
                        .padding(.horizontal, MiloTheme.Space.three)
                        .padding(.vertical, MiloTheme.Space.one + 2)
                        .frame(maxWidth: 100)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.sm))
                }
            }
            .padding(MiloTheme.Space.four)
            .miloGlassCard(radius: MiloTheme.Radius.lg)

            Text("How many memories enter each question. Leave empty to use Milo's default.")
                .font(MiloTheme.Text.meta)
                .foregroundStyle(MiloTheme.muted)
        }
    }

    private var embeddingSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Recall by meaning")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                HStack {
                    Text("State")
                        .font(MiloTheme.Text.base.weight(.medium))
                        .foregroundStyle(MiloTheme.foreground)
                    Spacer(minLength: 0)
                    Text(embeddingSummary)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }

                Button {
                    Task { await model.runSetupJob(kind: "embed-provision") }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Use this machine")
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                        Text("Downloads the engine (~1.9 GB) and a model, and runs them on the host.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.three)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                }
                .buttonStyle(PressableStyle())
                .disabled(model.setupJob?.status == "running")

                Button {
                    Task { await model.setMemoryEmbeddingOpenRouter() }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Use OpenRouter")
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                        Text("Uses the OpenRouter key. The notes leave the host machine.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                            .multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.three)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                }
                .buttonStyle(PressableStyle())
                .disabled(model.setupJob?.status == "running")

                if model.memoryEmbedding != nil {
                    Button(role: .destructive) {
                        Task { await model.clearMemoryEmbedding() }
                    } label: {
                        Text("Turn off")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(MiloTheme.danger)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.two)
                            .background(MiloTheme.danger.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .disabled(model.setupJob?.status == "running")
                }
            }
            .padding(MiloTheme.Space.four)
            .miloGlassCard(radius: MiloTheme.Radius.lg)

            if let job = model.setupJob {
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    HStack {
                        Text(job.status == "running" ? "Running…" : job.status == "done" ? "Done" : "Failed")
                            .font(MiloTheme.Text.base.weight(.semibold))
                            .foregroundStyle(MiloTheme.foreground)
                        Spacer(minLength: 0)
                        if job.status != "running" {
                            Button("Dismiss") { model.dismissSetupJob() }
                                .font(MiloTheme.Text.small.weight(.semibold))
                                .foregroundStyle(MiloTheme.accent)
                        }
                    }
                    if !job.lines.isEmpty {
                        Text(job.lines.joined(separator: "\n"))
                            .font(MiloTheme.Text.mono)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    if let error = job.error {
                        Text(error)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.danger)
                    }
                }
                .padding(MiloTheme.Space.four)
                .frame(maxWidth: .infinity, alignment: .leading)
                .miloGlassCard(radius: MiloTheme.Radius.lg)
            }

            Text(model.memoryEmbedding != nil
                ? "Restart Milo to apply embedding changes."
                : "When off, recall matches words only.")
                .font(MiloTheme.Text.meta)
                .foregroundStyle(MiloTheme.muted)
        }
    }

    private var derive: Binding<Bool> {
        Binding(
            get: { model.memoryDerive },
            set: { value in Task { await model.setMemoryDerive(value) } }
        )
    }

    private var embeddingSummary: String {
        guard let embedding = model.memoryEmbedding else { return "Off" }
        let place = embedding.provider == "ollama" ? "on this machine" : "on OpenRouter"
        if let modelName = embedding.model, !modelName.isEmpty {
            return "On — \(place) (\(modelName))"
        }
        return "On — \(place)"
    }

    private func commitRecallLimit() {
        let trimmed = recallLimitText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            guard model.memoryRecallLimit != nil else { return }
            Task { await model.setMemoryRecallLimit(nil) }
            return
        }
        guard let parsed = Int(trimmed), parsed >= 1 else {
            recallLimitText = model.memoryRecallLimit.map(String.init) ?? ""
            return
        }
        guard parsed != model.memoryRecallLimit else { return }
        Task { await model.setMemoryRecallLimit(parsed) }
    }
}
