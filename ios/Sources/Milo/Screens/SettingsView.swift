import SwiftUI

/**
 The settings the daemon owns. Nothing is kept on the phone: the screen reads the
 daemon's `overview` and writes with the daemon's own actions, so the terminal,
 the browser and this cannot come to disagree about what is configured.

 Three exceptions, each marked where it sits, and all because the subject is this phone's
 own screen rather than the install: appearance (system, light or dark), how the screen
 folds a chain of tool calls, and the reply notice, which only the phone it is shown on
 can raise.
 */
struct SettingsView: View {
    let account: Account
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var picker = false
    /// Read and written straight through: the chain under a message reads the same key,
    /// so a toggle here is a toggle there the moment it moves.
    @AppStorage("tools-folded") private var foldedTools = false
    /// The phone's own color scheme override (`system`, `light`, `dark`).
    @AppStorage("appearance") private var appearance = "system"
    /// The same shape for the phone's own reply notice: the key is the notifier's, so the
    /// switch that writes it and the reading that acts on it cannot come to disagree.
    @AppStorage(PhoneNotifications.replySetting) private var notifyReply = false

    private var colorScheme: ColorScheme? {
        switch appearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Model") {
                    Button { picker = true } label: {
                        // The id in full: a settings screen is where the exact
                        // name is information rather than noise.
                        LabeledContent("Model", value: model.modelName.isEmpty ? "—" : model.modelName)
                    }
                    Picker("Reasoning", selection: effort) {
                        ForEach(model.efforts, id: \.self) { value in
                            Text(SettingsWording.of(value)).tag(value)
                        }
                    }
                }

                Section {
                    Picker("Mode", selection: permission) {
                        ForEach(model.permissionModes, id: \.self) { value in
                            Text(SettingsWording.of(value)).tag(value)
                        }
                    }
                } header: {
                    Text("Permissions")
                } footer: {
                    // Said once, and only where it matters: with this on, nothing
                    // waits for the person.
                    Text(model.permissionMode == "yolo"
                        ? "Nothing asks before it runs."
                        : "A tool that can change something waits for you.")
                }

                Section("Display") {
                    Picker("Appearance", selection: $appearance) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    Picker("Tools", selection: tools) {
                        ForEach(model.toolLevels, id: \.self) { value in
                            Text(SettingsWording.of(value)).tag(value)
                        }
                    }
                    Toggle("Reasoning shown", isOn: thinking)
                    Toggle("Tool calls folded", isOn: $foldedTools)
                    Toggle("Interactive widgets (GenUI)", isOn: genui)
                }

                Section("Memory") {
                    NavigationLink {
                        MemorySettingsView()
                    } label: {
                        LabeledContent("Memory", value: memorySummary)
                    }
                }

                Section("Tools") {
                    Picker("Web search", selection: searchProvider) {
                        ForEach(model.searchProviders, id: \.self) { value in
                            Text(SettingsWording.searchProvider(value)).tag(value)
                        }
                    }
                    NavigationLink {
                        GoogleSettingsView()
                    } label: {
                        LabeledContent("Google", value: googleSummary)
                    }
                    NavigationLink {
                        BrowserSettingsView()
                    } label: {
                        LabeledContent("Browser", value: model.browserEnabled ? "On" : "Off")
                    }
                    NavigationLink {
                        McpSettingsView()
                    } label: {
                        LabeledContent("MCP servers", value: mcpSummary)
                    }
                }

                Section("Skills") {
                    NavigationLink {
                        SkillsSettingsView()
                    } label: {
                        LabeledContent(
                            "Skills",
                            value: model.installedSkills.isEmpty ? "None" : "\(model.installedSkills.count)"
                        )
                    }
                }

                Section {
                    Toggle("Notify when Milo replies", isOn: $notifyReply)
                } header: {
                    Text("Notifications")
                } footer: {
                    // What the switch comes to, said once under it — including the one
                    // thing that can stop it working, where the person looks for a reason.
                    Text(notifyReply && model.notificationsAllowed == false
                        ? "Notifications are off for Milo. Allow them in iOS Settings."
                        : "A banner when an answer lands and the app is not on screen.")
                }

                Section("Daemon") {
                    LabeledContent("Address", value: account.display)
                    LabeledContent("State", value: model.connection.wording)
                }

                if let error = model.settingsError {
                    Section {
                        Text(error)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.danger)
                    }
                }

                Section {
                    Button("Unpair this phone", role: .destructive) {
                        model.unpair()
                        dismiss()
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.loadSettings() }
            // Read without prompting, so a switch left on from an earlier run cannot read
            // as a promise the phone is not allowed to keep.
            .task { await model.readNotificationPermission() }
            .onChange(of: notifyReply) { _, on in
                // Turning it on is the moment to ask; the answer either way is what the
                // footer under it reads.
                guard on else { return }
                Task { await model.askToNotify() }
            }
            .sheet(isPresented: $picker) { ModelPickerSheet() }
        }
        .preferredColorScheme(colorScheme)
    }

    private var memorySummary: String {
        guard let stats = model.memoryStats else { return "" }
        return "\(stats.facts) fact\(stats.facts == 1 ? "" : "s")"
    }

    private var googleSummary: String {
        switch model.googleReport?.kind {
        case "connected": return model.googleReport?.email ?? "Connected"
        case "wanted": return "Not connected"
        default: return model.googleEnabled ? "On" : "Off"
        }
    }

    private var mcpSummary: String {
        let count = model.mcpReport?.servers.count ?? 0
        return count == 0 ? "None" : "\(count)"
    }

    /*
     Each control writes as it is set, and the local value is only taken once the
     daemon has agreed — a control that reads as moved when the write failed would
     be the screen lying.
     */
    private var effort: Binding<String> {
        Binding(
            get: { model.effort },
            set: { value in Task { await model.setEffort(value) } }
        )
    }

    private var permission: Binding<String> {
        Binding(
            get: { model.permissionMode },
            set: { value in Task { await model.setPermissionMode(value) } }
        )
    }

    private var tools: Binding<String> {
        Binding(
            get: { model.toolDisplay },
            set: { value in Task { await model.setToolDisplay(value) } }
        )
    }

    private var thinking: Binding<Bool> {
        Binding(
            get: { model.showThinking },
            set: { value in Task { await model.setShowThinking(value) } }
        )
    }

    private var genui: Binding<Bool> {
        Binding(
            get: { model.genui },
            set: { value in Task { await model.setGenui(value) } }
        )
    }

    private var searchProvider: Binding<String> {
        Binding(
            get: { model.searchProvider },
            set: { value in Task { await model.setSearchProvider(value) } }
        )
    }
}

// MARK: - Memory

private struct MemorySettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var recallLimitText = ""
    @FocusState private var recallFocused: Bool

    var body: some View {
        List {
            Section {
                Toggle("Save facts automatically", isOn: derive)
                HStack {
                    Text("Notes used per reply")
                    Spacer()
                    TextField("Default", text: $recallLimitText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .focused($recallFocused)
                        .frame(maxWidth: 110)
                }
            } footer: {
                Text("How many memories enter each question. Leave empty to use Milo's default.")
            }

            Section {
                LabeledContent("State", value: embeddingSummary)
                Button {
                    Task { await model.runSetupJob(kind: "embed-provision") }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Use this machine")
                        Text("Downloads the engine (~1.9 GB) and a model, and runs them on the host.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                .disabled(model.setupJob?.status == "running")

                Button {
                    Task { await model.setMemoryEmbeddingOpenRouter() }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Use OpenRouter")
                        Text("Uses the OpenRouter key. The notes leave the host machine.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
                .disabled(model.setupJob?.status == "running")

                if model.memoryEmbedding != nil {
                    Button("Turn off", role: .destructive) {
                        Task { await model.clearMemoryEmbedding() }
                    }
                    .disabled(model.setupJob?.status == "running")
                }
            } header: {
                Text("Recall by meaning")
            } footer: {
                if model.memoryEmbedding != nil {
                    Text("Restart Milo to apply embedding changes.")
                } else {
                    Text("When off, recall matches words only.")
                }
            }

            SetupJobSection()

            Section {
                if let notes = model.memoryNotes {
                    if notes.isEmpty {
                        Text("Nothing is remembered yet.")
                            .foregroundStyle(MiloTheme.muted)
                    } else {
                        ForEach(notes) { note in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note.text)
                                    .font(MiloTheme.Text.body)
                                HStack {
                                    Text("\(RelativeTime.when(note.createdAt)) · \(String(note.id.prefix(8)))")
                                        .font(MiloTheme.Text.small)
                                        .foregroundStyle(MiloTheme.muted)
                                    Spacer()
                                    Button("Forget", role: .destructive) {
                                        Task { await model.forgetMemoryNote(note.id) }
                                    }
                                    .font(MiloTheme.Text.small)
                                    .buttonStyle(.borderless)
                                }
                            }
                            .padding(.vertical, 2)
                            .swipeActions(edge: .trailing) {
                                Button("Forget", role: .destructive) {
                                    Task { await model.forgetMemoryNote(note.id) }
                                }
                            }
                        }
                    }
                } else {
                    Text("Reading…")
                        .foregroundStyle(MiloTheme.muted)
                }
            } header: {
                Text("Notes")
            } footer: {
                if let stats = model.memoryStats {
                    Text("\(stats.facts) fact\(stats.facts == 1 ? "" : "s") · \(SettingsWording.bytes(stats.bytes)) · \(stats.location)")
                }
            }

            SettingsErrorSection()
        }
        .navigationTitle("Memory")
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
        .task { await model.loadMemoryNotes() }
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

// MARK: - Google

private struct GoogleSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                Toggle("Enable Gmail and Drive", isOn: enabled)
            } footer: {
                Text("Restart Milo to apply.")
            }

            if let report = model.googleReport {
                if report.kind == "connected" {
                    Section("Account") {
                        LabeledContent("Account", value: report.email ?? "Connected")
                        if let connectedAt = report.connectedAt, connectedAt.count >= 10 {
                            LabeledContent("Connected since", value: String(connectedAt.prefix(10)))
                        }
                        if let tier = report.tier {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Access: \(tier.label)")
                                    .font(MiloTheme.Text.body)
                                Text(tier.description)
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                            }
                            .padding(.vertical, 2)
                        } else if let access = report.access {
                            LabeledContent("Access", value: access)
                        }
                    }

                    Section {
                        if !report.tools.isEmpty {
                            LabeledContent("Reading tools", value: report.tools.joined(separator: ", "))
                        }
                        if !report.writeTools.isEmpty {
                            LabeledContent("Write tools", value: report.writeTools.joined(separator: ", "))
                        }
                    } header: {
                        Text("Tools")
                    } footer: {
                        Text("To change access, run `milo google connect` on the machine Milo runs on. To disconnect, run `milo google forget`.")
                    }
                } else if report.kind == "wanted" {
                    Section("Connection") {
                        Text("The tools are on in the config, but no account has been allowed yet. Run `milo google connect` on the machine Milo runs on to choose the access level and sign in.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                } else {
                    Section("Connection") {
                        Text("Create an OAuth client in Google's console once, then run `milo google connect` on the machine Milo runs on to choose how much access to grant.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)
                    }
                }
            }

            SettingsErrorSection()
        }
        .navigationTitle("Google")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var enabled: Binding<Bool> {
        Binding(
            get: { model.googleEnabled },
            set: { value in Task { await model.setGoogleEnabled(value) } }
        )
    }
}

// MARK: - Browser

private struct BrowserSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var chromePath = ""
    @State private var profileDir = ""
    @State private var cdpUrl = ""

    var body: some View {
        List {
            Section {
                Toggle("Enable the browser", isOn: enabled)
                Toggle("Run without a visible window", isOn: headless)
            } footer: {
                Text("Restart Milo to apply browser enablement changes.")
            }

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Browser binary")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                    TextField("auto — the first one found", text: $chromePath)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            Task { await model.setBrowserChromePath(chromePath) }
                        }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Profile directory")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                    TextField("its own profile", text: $profileDir)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            Task { await model.setBrowserProfileDir(profileDir) }
                        }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Attach to (CDP URL)")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                    TextField("host:port", text: $cdpUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            Task { await model.setBrowserCdpUrl(cdpUrl) }
                        }
                }
                Stepper(
                    "Page snapshots kept: \(model.browserKeepSnapshots)",
                    value: keepSnapshots,
                    in: 0...50
                )
            } header: {
                Text("Configuration")
            } footer: {
                Text("Attach to a browser already running with remote debugging, or leave empty so Milo starts its own.")
            }

            Section("Setup") {
                Button("Find browsers") {
                    Task { await model.findBrowsers() }
                }
                Button("Download Chrome for Testing") {
                    Task { await model.runSetupJob(kind: "browser-install") }
                }
                .disabled(model.setupJob?.status == "running")

                Button("Find profiles") {
                    Task { await model.findProfiles() }
                }
            }

            if let browsers = model.detectedBrowsers {
                Section("Detected browsers") {
                    if browsers.isEmpty {
                        Text("No browser found on the host machine.")
                            .foregroundStyle(MiloTheme.muted)
                    } else {
                        ForEach(browsers) { browser in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(browser.version.map { "\(browser.name) · \($0)" } ?? browser.name)
                                        .font(MiloTheme.Text.body)
                                    Text(browser.path)
                                        .font(MiloTheme.Text.small)
                                        .foregroundStyle(MiloTheme.muted)
                                }
                                Spacer()
                                Button("Use") {
                                    chromePath = browser.path
                                    Task { await model.setBrowserChromePath(browser.path) }
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }

            if let profiles = model.detectedProfiles {
                Section("Detected profiles") {
                    if profiles.isEmpty {
                        Text("No browser profiles found.")
                            .foregroundStyle(MiloTheme.muted)
                    } else {
                        ForEach(profiles) { profile in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(profile.browserName)
                                        .font(MiloTheme.Text.body)
                                    Text(profile.profileDir)
                                        .font(MiloTheme.Text.small)
                                        .foregroundStyle(MiloTheme.muted)
                                }
                                Spacer()
                                Button("Copy into Milo") {
                                    Task {
                                        await model.runSetupJob(
                                            kind: "profile-copy",
                                            extra: ["id": profile.browserId, "dir": profile.profileDir]
                                        )
                                    }
                                }
                                .buttonStyle(.borderless)
                                .disabled(model.setupJob?.status == "running")
                            }
                        }
                    }
                }
            }

            SetupJobSection()
            SettingsErrorSection()
        }
        .navigationTitle("Browser")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { syncFields() }
        .onChange(of: model.browserChromePath) { _, _ in syncFields() }
        .onChange(of: model.browserProfileDir) { _, _ in syncFields() }
        .onChange(of: model.browserCdpUrl) { _, _ in syncFields() }
        .onDisappear { commitFields() }
    }

    private var enabled: Binding<Bool> {
        Binding(
            get: { model.browserEnabled },
            set: { value in Task { await model.setBrowserEnabled(value) } }
        )
    }

    private var headless: Binding<Bool> {
        Binding(
            get: { model.browserHeadless },
            set: { value in Task { await model.setBrowserHeadless(value) } }
        )
    }

    private var keepSnapshots: Binding<Int> {
        Binding(
            get: { model.browserKeepSnapshots },
            set: { value in Task { await model.setBrowserKeepSnapshots(value) } }
        )
    }

    private func syncFields() {
        chromePath = model.browserChromePath ?? ""
        profileDir = model.browserProfileDir ?? ""
        cdpUrl = model.browserCdpUrl ?? ""
    }

    private func commitFields() {
        if chromePath != (model.browserChromePath ?? "") {
            let next = chromePath
            Task { await model.setBrowserChromePath(next) }
        }
        if profileDir != (model.browserProfileDir ?? "") {
            let next = profileDir
            Task { await model.setBrowserProfileDir(next) }
        }
        if cdpUrl != (model.browserCdpUrl ?? "") {
            let next = cdpUrl
            Task { await model.setBrowserCdpUrl(next) }
        }
    }
}

// MARK: - MCP servers

private struct McpSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if let error = model.mcpReport?.error {
                Section {
                    Text("mcp.json could not be read: \(error)")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.danger)
                }
            }

            Section {
                let servers = model.mcpReport?.servers ?? []
                if servers.isEmpty {
                    Text("No MCP servers configured.")
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    ForEach(servers) { server in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(server.name)
                                    .font(MiloTheme.Text.body)
                                Spacer()
                                if server.enabled {
                                    Button("Check") {
                                        Task {
                                            await model.runSetupJob(
                                                kind: "mcp-check",
                                                extra: ["name": server.name]
                                            )
                                        }
                                    }
                                    .font(MiloTheme.Text.small)
                                    .buttonStyle(.borderless)
                                    .disabled(model.setupJob?.status == "running")
                                }
                                Button(server.enabled ? "Disable" : "Enable") {
                                    Task { await model.toggleMcpServer(server.name, enabled: !server.enabled) }
                                }
                                .font(MiloTheme.Text.small)
                                .buttonStyle(.borderless)
                            }
                            Text("\(server.command) · \(describe(server))")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                            if !server.readOnly.isEmpty {
                                Text("Always allowed: \(server.readOnly.joined(separator: ", "))")
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                            }
                            if let serverError = server.error {
                                Text(serverError)
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.danger)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            } header: {
                Text("Servers")
            } footer: {
                if let file = model.mcpReport?.file, !file.isEmpty {
                    Text("Configured in \(file).")
                }
            }

            Section {
                Button("Re-read mcp.json") {
                    Task { await model.reloadMcp() }
                }
            }

            SetupJobSection()
            SettingsErrorSection()
        }
        .navigationTitle("MCP servers")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func describe(_ server: McpServer) -> String {
        if !server.enabled { return "Off — its tools are out of the catalog." }
        let tools = "\(server.tools) tool\(server.tools == 1 ? "" : "s")"
        let listed = server.listingAt.map { " · last listed \(RelativeTime.when($0))" } ?? ""
        switch server.state {
        case "ready": return "Connected · \(tools)"
        case "connecting": return "Connecting… · \(tools) so far"
        case "failed": return "Not running · \(tools) from the last listing"
        default:
            return server.listingAt != nil
                ? "\(tools) from the last listing\(listed)"
                : "Not connected yet — Check connects it now."
        }
    }
}

// MARK: - Skills

private struct SkillsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var source = ""
    @State private var busy = false

    var body: some View {
        List {
            Section("Installed") {
                if model.installedSkills.isEmpty {
                    Text("No skills installed.")
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    ForEach(model.installedSkills) { skill in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(skill.name)
                                    .font(MiloTheme.Text.body)
                                Spacer()
                                Button("Remove", role: .destructive) {
                                    Task { await model.removeSkill(skill.name) }
                                }
                                .font(MiloTheme.Text.small)
                                .buttonStyle(.borderless)
                            }
                            Text(skill.origin.map { "\(skill.description) · \($0)" } ?? skill.description)
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(.vertical, 2)
                        .swipeActions(edge: .trailing) {
                            Button("Remove", role: .destructive) {
                                Task { await model.removeSkill(skill.name) }
                            }
                        }
                    }
                }
            }

            Section {
                TextField("owner/repo, URL, or path", text: $source)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: source) { _, _ in model.clearSkillChoices() }
                Button("Install skill") {
                    Task { await install(skill: nil) }
                }
                .disabled(busy || source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if let choices = model.skillChoices, !choices.isEmpty {
                    ForEach(choices, id: \.self) { choice in
                        Button("Install \(choice)") {
                            Task { await install(skill: choice) }
                        }
                        .disabled(busy)
                    }
                }
            } header: {
                Text("Add a skill")
            } footer: {
                if model.skillChoices != nil {
                    Text("This repository holds more than one skill. Pick the one to install.")
                }
            }

            Section("Popular skills") {
                if model.popularSkillsLoading && model.popularSkills.isEmpty {
                    Text("Loading…")
                        .foregroundStyle(MiloTheme.muted)
                } else if model.popularSkills.isEmpty {
                    Text("Directory could not be reached.")
                        .foregroundStyle(MiloTheme.muted)
                } else {
                    ForEach(model.popularSkills) { item in
                        let installed = model.installedSkills.contains { $0.name == item.name }
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                    .font(MiloTheme.Text.body)
                                Text(popularSubtitle(item))
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                            }
                            Spacer()
                            Button(installed ? "Installed" : "Install") {
                                Task {
                                    busy = true
                                    defer { busy = false }
                                    _ = await model.installSkill(source: item.repo, skill: item.name)
                                }
                            }
                            .font(MiloTheme.Text.small)
                            .buttonStyle(.borderless)
                            .disabled(installed || busy)
                        }
                    }
                }
            }

            SettingsErrorSection()
        }
        .navigationTitle("Skills")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadPopularSkills() }
    }

    private func install(skill: String?) async {
        busy = true
        defer { busy = false }
        if await model.installSkill(source: source, skill: skill) {
            source = ""
        }
    }

    private func popularSubtitle(_ item: PopularSkill) -> String {
        var parts = [item.repo]
        if let installs = item.installs {
            parts.append("\(installs.formatted()) installs")
        }
        if let description = item.description, !description.isEmpty {
            parts.append(description)
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Shared sections

private struct SetupJobSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let job = model.setupJob {
            Section("Job") {
                HStack {
                    Text(job.status == "running" ? "Running…" : job.status == "done" ? "Done" : "Failed")
                        .font(MiloTheme.Text.body)
                    Spacer()
                    if job.status != "running" {
                        Button("Dismiss") { model.dismissSetupJob() }
                            .font(MiloTheme.Text.small)
                            .buttonStyle(.borderless)
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
        }
    }
}

private struct SettingsErrorSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let error = model.settingsError {
            Section {
                Text(error)
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.danger)
            }
        }
    }
}

/**
 How a bare token reads as a control. The daemon sends the *values* it accepts —
 the set a client may offer — and the words are this surface's. A token this app
 has never seen still shows, capitalised, rather than being dropped from the
 screen because nobody taught the phone about it.
 */
enum SettingsWording {
    static func of(_ value: String) -> String {
        switch value {
        case "yolo": return "YOLO"
        case "name": return "Name only"
        default: return value.prefix(1).uppercased() + String(value.dropFirst())
        }
    }

    static func searchProvider(_ value: String) -> String {
        switch value {
        case "off": return "Off"
        case "tavily": return "Tavily"
        case "exa": return "Exa"
        case "parallel": return "Parallel"
        default: return of(value)
        }
    }

    static func bytes(_ count: Int) -> String {
        if count < 1024 { return "\(count) B" }
        if count < 1024 * 1024 { return String(format: "%.1f KB", Double(count) / 1024.0) }
        return String(format: "%.1f MB", Double(count) / (1024.0 * 1024.0))
    }
}
