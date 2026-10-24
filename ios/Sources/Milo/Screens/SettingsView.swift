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
    /// The phone's own color scheme override (`system`, `light`, `dark`). It lives here
    /// because the whole sheet follows it; the Display page edits the same value through
    /// a binding rather than reading the key a second time.
    @AppStorage("appearance") private var appearance = "system"

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
                // The sections the browser lists, in its own order: one row per
                // category, an icon and its name. The value each one holds is read on
                // its own page, not previewed here.
                Section {
                    category("Provider & model", icon: "cpu") {
                        ProviderSettingsView()
                    }
                    category("API keys", icon: "key") {
                        ApiKeysSettingsView()
                    }
                    category("Memory", icon: "cylinder") {
                        MemorySettingsView()
                    }
                    category("Gateways", icon: "server.rack") {
                        GatewaysSettingsView()
                    }
                    category("Web", icon: "globe") {
                        WebSettingsView()
                    }
                    category("Tools", icon: "wrench.and.screwdriver") {
                        ToolsSettingsView()
                    }
                    category("Permissions", icon: "shield") {
                        PermissionsSettingsView()
                    }
                    category("Display", icon: "eye") {
                        DisplaySettingsView(appearance: $appearance)
                    }
                    category("Skills", icon: "sparkles") {
                        SkillsSettingsView()
                    }
                    category("Sessions", icon: "clock.arrow.circlepath") {
                        SessionsSettingsView()
                    }
                }

                Section("Daemon") {
                    LabeledContent("Address", value: account.display)
                    LabeledContent("State", value: model.connection.wording)
                }

                SettingsErrorSection()

                Section {
                    Button("Unpair this phone", role: .destructive) {
                        model.unpair()
                        dismiss()
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            // The index carries no header on its first section, and the list reserves
            // room for one either way — a blank band above the first row. Both of these
            // are what that band is made of.
            .contentMargins(.top, 0, for: .scrollContent)
            .environment(\.defaultMinListHeaderHeight, 0)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.loadSettings() }
        }
        .preferredColorScheme(colorScheme)
    }

    /// One category: its icon, its name, and the page behind it. Nothing about what is
    /// set appears here — the value belongs on the page, once.
    private func category<Destination: View>(
        _ title: String,
        icon: String,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    // The page's own ink, not the muted secondary: the icon is how a
                    // category is recognised, and a caption weight read as a hairline.
                    .font(MiloTheme.Text.body.weight(.semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .frame(width: 24, alignment: .center)
                Text(title)
            }
        }
    }
}

// MARK: - Provider & model

private struct ProviderSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var picker = false

    var body: some View {
        List {
            Section("Model") {
                Button { picker = true } label: {
                    // The id in full: a settings screen is where the exact name is
                    // information rather than noise.
                    LabeledContent("Model", value: model.modelName.isEmpty ? "—" : model.modelName)
                }
                Picker("Reasoning", selection: effort) {
                    ForEach(model.efforts, id: \.self) { value in
                        Text(SettingsWording.of(value)).tag(value)
                    }
                }
            }
            SettingsErrorSection()
        }
        .navigationTitle("Provider & model")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $picker) { ModelPickerSheet() }
    }

    private var effort: Binding<String> {
        Binding(
            get: { model.effort },
            set: { value in Task { await model.setEffort(value) } }
        )
    }
}

// MARK: - Tools

private struct ToolsSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
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
            SettingsErrorSection()
        }
        .navigationTitle("Tools")
        .navigationBarTitleDisplayMode(.inline)
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

    private var searchProvider: Binding<String> {
        Binding(
            get: { model.searchProvider },
            set: { value in Task { await model.setSearchProvider(value) } }
        )
    }
}

// MARK: - Display

private struct DisplaySettingsView: View {
    @Environment(AppModel.self) private var model
    /// Bound from the screen above, which applies it to the whole sheet.
    @Binding var appearance: String
    /// Read and written straight through: the chain under a message reads the same key,
    /// so a toggle here is a toggle there the moment it moves.
    @AppStorage("tools-folded") private var foldedTools = false
    /// The same shape for the phone's own reply notice: the key is the notifier's, so the
    /// switch that writes it and the reading that acts on it cannot come to disagree.
    @AppStorage(PhoneNotifications.replySetting) private var notifyReply = false

    var body: some View {
        List {
            Section {
                Picker("Appearance", selection: $appearance) {
                    Text("System theme").tag("system")
                    Text("Light theme").tag("light")
                    Text("Dark theme").tag("dark")
                }
            } footer: {
                Text("Applies to this phone only.")
            }

            Section {
                Picker("Tool detail", selection: tools) {
                    ForEach(model.toolLevels, id: \.self) { value in
                        Text(SettingsWording.of(value)).tag(value)
                    }
                }
                Picker("Reasoning", selection: thinking) {
                    ForEach(model.thinkingLevels, id: \.self) { value in
                        Text(SettingsWording.of(value)).tag(value)
                    }
                }
                Toggle("Tool calls folded", isOn: $foldedTools)
                Toggle("Interactive widgets (GenUI)", isOn: genui)
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

            SettingsErrorSection()
        }
        .navigationTitle("Display")
        .navigationBarTitleDisplayMode(.inline)
        // Read without prompting, so a switch left on from an earlier run cannot read
        // as a promise the phone is not allowed to keep.
        .task { await model.readNotificationPermission() }
        .onChange(of: notifyReply) { _, on in
            // Turning it on is the moment to ask; the answer either way is what the
            // footer under it reads.
            guard on else { return }
            Task { await model.askToNotify() }
        }
    }

    private var tools: Binding<String> {
        Binding(
            get: { model.toolDisplay },
            set: { value in Task { await model.setToolDisplay(value) } }
        )
    }

    private var thinking: Binding<String> {
        Binding(
            get: { model.thinking },
            set: { value in Task { await model.setThinking(value) } }
        )
    }

    private var genui: Binding<Bool> {
        Binding(
            get: { model.genui },
            set: { value in Task { await model.setGenui(value) } }
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

// MARK: - Permissions

private struct PermissionsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var allowText = ""
    @State private var denyText = ""
    @State private var classifierModel = ""
    @State private var classifierUrl = ""
    @FocusState private var field: Field?

    private enum Field: Hashable { case allow, deny, model, url }

    var body: some View {
        List {
            Section {
                Picker("Mode", selection: mode) {
                    ForEach(model.permissionModes, id: \.self) { value in
                        Text(SettingsWording.of(value)).tag(value)
                    }
                }
            } footer: {
                Text(model.permissionMode == "yolo"
                    ? "Nothing asks before it runs."
                    : "A tool that can change something waits for you.")
            }

            Section {
                HStack {
                    Text("Always allowed")
                    Spacer()
                    TextField("None", text: $allowText)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .allow)
                        .onSubmit { field = nil }
                }
                HStack {
                    Text("Blocked")
                    Spacer()
                    TextField("None", text: $denyText)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .deny)
                        .onSubmit { field = nil }
                }
            } footer: {
                // Both lists in one line, said once: commas, and which one wins.
                Text("Comma-separated tool names. An allowed tool is never asked about; a blocked one never runs — unless the mode is YOLO.")
            }

            Section {
                Stepper(value: threshold, in: 0...1, step: 0.05) {
                    LabeledContent("Threshold", value: String(format: "%.2f", model.permissions.jevThreshold))
                }
            } header: {
                Text("Reviewer")
            } footer: {
                Text("Danger score the reviewer tolerates: below it the tool runs, at or above it asks.")
            }

            Section {
                Picker("Backend", selection: backend) {
                    ForEach(model.classifierBackends, id: \.self) { value in
                        Text(SettingsWording.classifierBackend(value)).tag(value)
                    }
                }
                HStack {
                    Text("Model")
                    Spacer()
                    TextField("Backend default", text: $classifierModel)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .model)
                        .onSubmit { field = nil }
                }
                HStack {
                    Text("URL")
                    Spacer()
                    TextField("Backend default", text: $classifierUrl)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .url)
                        .onSubmit { field = nil }
                }
            } footer: {
                Text("The decision model a review is asked of. Applies on the next start.")
            }

            SettingsErrorSection()
        }
        .navigationTitle("Permissions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { field = nil }
            }
        }
        .onAppear { syncFields() }
        .onChange(of: model.permissions) { _, _ in if field == nil { syncFields() } }
        .onChange(of: model.classifier) { _, _ in if field == nil { syncFields() } }
        .onChange(of: field) { _, next in if next == nil { commitFields() } }
        .onDisappear { commitFields() }
    }

    private var mode: Binding<String> {
        Binding(
            get: { model.permissions.mode },
            set: { value in Task { await model.setPermissions { $0.mode = value } } }
        )
    }

    private var backend: Binding<String> {
        Binding(
            get: { model.classifier.backend },
            set: { value in Task { await model.setClassifier { $0.backend = value } } }
        )
    }

    /// Kept on the reviewer's own fifth, so a gesture never lands on 0.3500000000000001.
    private var threshold: Binding<Double> {
        Binding(
            get: { model.permissions.jevThreshold },
            set: { value in
                let stepped = min(1, max(0, (value * 20).rounded() / 20))
                Task { await model.setPermissions { $0.jevThreshold = stepped } }
            }
        )
    }

    private func syncFields() {
        allowText = model.permissions.allow.joined(separator: ", ")
        denyText = model.permissions.deny.joined(separator: ", ")
        classifierModel = model.classifier.model ?? ""
        classifierUrl = model.classifier.url ?? ""
    }

    private func commitFields() {
        let allow = splitNames(allowText)
        let deny = splitNames(denyText)
        let nextModel = trimmedOrNil(classifierModel)
        let nextUrl = trimmedOrNil(classifierUrl)
        Task {
            if allow != model.permissions.allow || deny != model.permissions.deny {
                await model.setPermissions { next in
                    next.allow = allow
                    next.deny = deny
                }
            }
            if nextModel != model.classifier.model || nextUrl != model.classifier.url {
                await model.setClassifier { next in
                    next.model = nextModel
                    next.url = nextUrl
                }
            }
            await MainActor.run { if field == nil { syncFields() } }
        }
    }
}

// MARK: - API keys

/**
 The four groups the keys screen lists, and the ids each one holds — the browser's own
 grouping, so a key sits under the same heading on both surfaces.
 */
private enum KeyGroup: String, CaseIterable {
    case providers, audio, search, gateways

    var title: String {
        switch self {
        case .providers: return "Providers"
        case .audio: return "Audio"
        case .search: return "Web search"
        case .gateways: return "Gateways"
        }
    }

    var footer: String {
        switch self {
        case .providers: return "Keys are stored on the machine that runs Milo. This screen only reads whether one is set."
        case .audio: return "Groq's Whisper key, used for audio transcription."
        case .search: return "The key for each search service."
        case .gateways: return "The bot token for each channel; whether a channel runs is under Gateways."
        }
    }

    func ids(presets: [SettingsOverview.Preset], auth: SettingsOverview.Auth?) -> [String] {
        switch self {
        case .providers:
            var ids = presets.map(\.id).filter { !$0.isEmpty && $0 != "groq" }
            for id in auth.map({ Array($0.providers.keys) }) ?? [] where id != "groq" && !ids.contains(id) {
                ids.append(id)
            }
            return ids
        case .audio: return ["groq"]
        case .search: return ["tavily", "exa", "parallel"]
        case .gateways: return ["telegram", "discord"]
        }
    }

    func state(_ auth: SettingsOverview.Auth?, id: String) -> SettingsOverview.SecretState? {
        switch self {
        case .providers: return auth?.providers[id]
        case .audio: return auth?.audio[id]
        case .search: return auth?.search[id]
        case .gateways: return auth?.gateways[id]
        }
    }
}

private struct ApiKeysSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: String?
    @State private var draft = ""
    @State private var busy = false
    @FocusState private var typing: Bool

    var body: some View {
        List {
            ForEach(KeyGroup.allCases, id: \.self) { group in
                Section {
                    let ids = ordered(group)
                    if ids.isEmpty {
                        Text("No provider to list yet.")
                            .foregroundStyle(MiloTheme.muted)
                    } else {
                        ForEach(ids, id: \.self) { id in
                            row(group: group, id: id)
                        }
                    }
                } header: {
                    Text(group.title)
                } footer: {
                    Text(group.footer)
                }
            }
            SettingsErrorSection()
        }
        .navigationTitle("API keys")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                // The keyboard goes away; what was typed stays, so Save is still the one
                // thing that writes it.
                Button("Done") { typing = false }
            }
        }
    }

    /// Configured keys first, as the browser lists them, and the rest in the order the
    /// daemon offered — a list that reorders only when a key is actually added.
    private func ordered(_ group: KeyGroup) -> [String] {
        let ids = group.ids(presets: model.presets, auth: model.auth)
        let configured = ids.filter { group.state(model.auth, id: $0)?.set == true }
        return configured + ids.filter { group.state(model.auth, id: $0)?.set != true }
    }

    private func name(group: KeyGroup, id: String) -> String {
        guard group == .providers else { return SettingsWording.of(id) }
        return model.presets.first { $0.id == id }?.name ?? id
    }

    @ViewBuilder
    private func row(group: KeyGroup, id: String) -> some View {
        let state = group.state(model.auth, id: id)
        let configured = state?.set == true
        let slot = "\(group.rawValue):\(id)"
        let open = editing == slot
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(group: group, id: id))
                        .font(MiloTheme.Text.body)
                    Text(configured ? (state?.masked ?? "Set") : "Not set")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                Spacer()
                Button(open ? "Cancel" : configured ? "Replace" : "Add key") {
                    if open {
                        closeEditor()
                    } else {
                        editing = slot
                        draft = ""
                        typing = true
                    }
                }
                .font(MiloTheme.Text.small)
                .buttonStyle(.borderless)
                if configured && !open {
                    Button("Remove", role: .destructive) {
                        busy = true
                        Task {
                            await model.removeSecret(group: group.rawValue, id: id)
                            busy = false
                        }
                    }
                    .font(MiloTheme.Text.small)
                    .buttonStyle(.borderless)
                    .disabled(busy)
                }
            }
            if open {
                SecureField("API key", text: $draft)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($typing)
                HStack {
                    Spacer()
                    Button("Save") {
                        busy = true
                        Task {
                            let saved = await model.saveSecret(group: group.rawValue, id: id, value: draft)
                            busy = false
                            if saved { closeEditor() }
                        }
                    }
                    .font(MiloTheme.Text.small)
                    .buttonStyle(.borderless)
                    .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func closeEditor() {
        editing = nil
        draft = ""
        typing = false
    }
}

// MARK: - Gateways

private struct GatewaysSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var drafts: [String: String] = [:]
    @FocusState private var focused: String?

    private let names = ["telegram", "discord"]

    var body: some View {
        List {
            ForEach(names, id: \.self) { name in
                Section {
                    Toggle("Enable \(SettingsWording.of(name))", isOn: enabled(name))
                    HStack {
                        Text("Allowed people")
                        Spacer()
                        TextField("Anyone", text: text(name))
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focused, equals: name)
                            .onSubmit {
                                focused = nil
                                commit(name)
                            }
                    }
                } footer: {
                    Text("Leave empty to allow anyone who finds the bot.")
                }
            }
            SettingsErrorSection()
        }
        .navigationTitle("Gateways")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focused = nil }
            }
        }
        .onAppear { for name in names { sync(name) } }
        .onChange(of: focused) { _, next in
            // The field that lost focus writes what it holds, then reads the daemon's own
            // answer back — a refused list returns the stored one instead of a list that
            // was never kept on screen.
            guard next == nil else { return }
            for name in names { commit(name) }
        }
        .onChange(of: model.gateways) { _, _ in
            guard focused == nil else { return }
            for name in names { sync(name) }
        }
        .onDisappear {
            for name in names { commit(name) }
        }
    }

    private func enabled(_ name: String) -> Binding<Bool> {
        Binding(
            get: { model.gateways[name]?.enabled ?? false },
            set: { on in
                // Whatever is in the field goes with it, so a list typed just before the
                // switch is not left to be written by a later commit over the top of it.
                let list = drafts[name].map(splitNames) ?? (model.gateways[name]?.allowlist ?? [])
                Task { await model.setGateway(name, enabled: on, allowlist: list) }
            }
        )
    }

    private func text(_ name: String) -> Binding<String> {
        Binding(
            get: { drafts[name] ?? "" },
            set: { drafts[name] = $0 }
        )
    }

    private func sync(_ name: String) {
        drafts[name] = (model.gateways[name]?.allowlist ?? []).joined(separator: ", ")
    }

    private func commit(_ name: String) {
        let next = splitNames(drafts[name] ?? "")
        let current = model.gateways[name] ?? AppModel.GatewaySettings()
        guard next != current.allowlist else { return }
        Task {
            let written = await model.setGateway(name, enabled: current.enabled, allowlist: next)
            await MainActor.run {
                if !written || focused != name { sync(name) }
            }
        }
    }
}

// MARK: - Web

private struct WebSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var host = ""
    @State private var port = ""
    @FocusState private var field: Field?

    private enum Field: Hashable { case host, port }

    var body: some View {
        List {
            Section {
                Toggle("Serve it with milo serve", isOn: enabled)
            }

            Section {
                HStack {
                    Text("Bind address")
                    Spacer()
                    TextField("127.0.0.1", text: $host)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .host)
                        .onSubmit { field = nil }
                }
                HStack {
                    Text("Port")
                    Spacer()
                    TextField("7717", text: $port)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .focused($field, equals: .port)
                }
            } header: {
                Text("Address")
            } footer: {
                Text("Read when milo serve starts. Anything but loopback is reachable from the network — the token is then the only thing between a stranger and this install.")
            }

            SettingsErrorSection()
        }
        .navigationTitle("Web")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { field = nil }
            }
        }
        .onAppear { sync() }
        .onChange(of: model.web) { _, _ in if field == nil { sync() } }
        .onChange(of: field) { _, next in if next == nil { commit() } }
        .onDisappear { commit() }
    }

    private var enabled: Binding<Bool> {
        Binding(
            get: { model.web.enabled },
            set: { value in Task { await model.setWebEnabled(value) } }
        )
    }

    private func sync() {
        host = model.web.host
        port = String(model.web.port)
    }

    /// The two fields are committed in order, and the screen then reads the daemon's own
    /// answer back: a blank address or a port outside the range comes back refused, and
    /// the field shows what is really configured rather than what was typed.
    private func commit() {
        let nextHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextPort = Int(port.trimmingCharacters(in: .whitespacesAndNewlines))
        let hostChanged = nextHost != model.web.host
        let portChanged = nextPort != nil && nextPort != model.web.port
        guard hostChanged || portChanged else {
            if field == nil { sync() }
            return
        }
        Task {
            if hostChanged { await model.setWebHost(nextHost) }
            if let nextPort, portChanged { await model.setWebPort(nextPort) }
            await MainActor.run { if field == nil { sync() } }
        }
    }
}

// MARK: - Sessions

private struct SessionsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var sessionsText = ""
    @State private var budgetText = ""
    @State private var windowText = ""
    @State private var titleModelText = ""
    @FocusState private var field: Field?

    private enum Field: Hashable { case sessions, budget, window, titleModel }

    var body: some View {
        List {
            Section {
                Stepper(
                    "Compact at \(Int((model.transcript.compactAt * 100).rounded()))% of the context",
                    value: compactPercent,
                    in: 1...95,
                    step: 5
                )
                Stepper("Turns kept verbatim: \(model.transcript.keepTurns)", value: keepTurns, in: 1...50)
                Toggle("Compact long sessions automatically", isOn: compaction)
            } header: {
                Text("Compaction")
            } footer: {
                Text("The share of the model's window that triggers a fold. Turns older than the ones kept are summarized.")
            }

            Section {
                Toggle("Name each session from its first turn", isOn: generateTitles)
                HStack {
                    Text("Model that writes the names")
                    Spacer()
                    TextField("Its own model", text: $titleModelText)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .titleModel)
                        .onSubmit { field = nil }
                }
            } header: {
                Text("Names")
            } footer: {
                Text("One short call after the first turn. Empty uses the session's own model.")
            }

            Section {
                numberRow("Sessions kept", text: $sessionsText, field: .sessions)
                numberRow("Fallback budget (tokens)", text: $budgetText, field: .budget)
                numberRow("Context window (tokens)", text: $windowText, field: .window)
            } header: {
                Text("Storage")
            } footer: {
                Text("How many sessions stay on disk. The fallback budget is used only when the model's window is unknown; the context window overrides the catalog for a model it does not know.")
            }

            SettingsErrorSection()
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { field = nil }
            }
        }
        .onAppear { syncFields() }
        .onChange(of: model.transcript) { _, _ in if field == nil { syncFields() } }
        .onChange(of: field) { _, next in if next == nil { commitFields() } }
        .onDisappear { commitFields() }
    }

    private func numberRow(_ label: String, text: Binding<String>, field value: Field) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("", text: text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .focused($field, equals: value)
        }
    }

    private var compactPercent: Binding<Int> {
        Binding(
            get: { Int((model.transcript.compactAt * 100).rounded()) },
            set: { value in
                let percent = min(95, max(1, value))
                Task { await model.setTranscript { $0.compactAt = Double(percent) / 100 } }
            }
        )
    }

    private var keepTurns: Binding<Int> {
        Binding(
            get: { model.transcript.keepTurns },
            set: { value in Task { await model.setTranscript { $0.keepTurns = max(1, value) } } }
        )
    }

    private var compaction: Binding<Bool> {
        Binding(
            get: { model.transcript.compaction },
            set: { value in Task { await model.setTranscript { $0.compaction = value } } }
        )
    }

    private var generateTitles: Binding<Bool> {
        Binding(
            get: { model.transcript.generateTitles },
            set: { value in Task { await model.setTranscript { $0.generateTitles = value } } }
        )
    }

    private func syncFields() {
        sessionsText = String(model.transcript.maxSessions)
        budgetText = String(model.transcript.maxInputTokens)
        windowText = model.transcript.contextWindow.map(String.init) ?? ""
        titleModelText = model.transcript.titleModel ?? ""
    }

    /// A number that does not parse is left as it was: the field then reads the stored
    /// value back, which is the daemon's answer rather than a silent write of something
    /// nobody typed.
    private func commitFields() {
        let maxSessions = Int(sessionsText.trimmingCharacters(in: .whitespacesAndNewlines))
        let budget = Int(budgetText.trimmingCharacters(in: .whitespacesAndNewlines))
        let window = trimmedOrNil(windowText)
        let titleModel = trimmedOrNil(titleModelText)
        Task {
            await model.setTranscript { next in
                if let maxSessions, maxSessions >= 1 { next.maxSessions = maxSessions }
                if let budget, budget >= 1024 { next.maxInputTokens = budget }
                if window == nil {
                    next.contextWindow = nil
                } else if let parsed = Int(window ?? ""), parsed >= 1024 {
                    next.contextWindow = parsed
                }
                next.titleModel = titleModel
            }
            await MainActor.run { if field == nil { syncFields() } }
        }
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

/** A comma-separated field as the list it stands for: trimmed, with blanks dropped. */
private func splitNames(_ text: String) -> [String] {
    text.split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

/** A field that is allowed to be empty, where empty means "the daemon's own default". */
private func trimmedOrNil(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
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

    static func classifierBackend(_ value: String) -> String {
        switch value {
        case "commandcode": return "Hosted"
        case "openai": return "OpenAI"
        case "openrouter": return "OpenRouter"
        case "ollaya": return "Ollaya"
        case "custom": return "Custom"
        default: return of(value)
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
