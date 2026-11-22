import SwiftUI

/// Hub and pinned-tab Skills surface, matching the workspace glass-card design language.
struct SkillsView: View {
    let embeddedInHub: Bool

    @Environment(AppModel.self) private var model
    @State private var source = ""
    @State private var busy = false

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

                addSkillSection
                installedSection
                popularSection
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
        .refreshable {
            await model.loadSettings()
            await model.loadPopularSkills()
        }
        .task(id: model.accountDisplay) {
            await model.ensureSettingsLoaded()
            await model.loadPopularSkills()
        }
        .onChange(of: model.onlineEpoch) { _, _ in
            Task {
                await model.loadSettings()
                await model.loadPopularSkills()
            }
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                Text("WORKSPACE")
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .tracking(1.1)
            }
            .foregroundStyle(MiloTheme.accent)

            Text("Skills")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(MiloTheme.foreground)

            Text("Reusable capabilities Milo can load when a task calls for them.")
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.muted)

            Text("\(model.installedSkills.count) installed")
                .font(MiloTheme.Text.small.weight(.medium))
                .foregroundStyle(MiloTheme.foreground)
                .padding(.top, MiloTheme.Space.one)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.five)
        .miloGlassCard(radius: MiloTheme.Radius.xl)
    }

    private var addSkillSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Add a skill")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                HStack(spacing: MiloTheme.Space.two) {
                    TextField("owner/repo, URL, or path", text: $source)
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.foreground)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: source) { _, _ in model.clearSkillChoices() }

                    let empty = source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button {
                        Task { await install(skill: nil) }
                    } label: {
                        Text(busy ? "Installing…" : "Install")
                            .font(MiloTheme.Text.small.weight(.semibold))
                            .foregroundStyle(empty || busy ? MiloTheme.muted : MiloTheme.accentOn)
                            .padding(.horizontal, MiloTheme.Space.three)
                            .padding(.vertical, MiloTheme.Space.two)
                            .background(empty || busy ? MiloTheme.surface : MiloTheme.accent, in: Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .disabled(busy || empty)
                }

                if let choices = model.skillChoices, !choices.isEmpty {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                        Text("This repository holds more than one skill. Pick the one to install.")
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(MiloTheme.muted)

                        ForEach(choices, id: \.self) { choice in
                            Button {
                                Task { await install(skill: choice) }
                            } label: {
                                HStack {
                                    Text("Install \(choice)")
                                        .font(MiloTheme.Text.base.weight(.medium))
                                        .foregroundStyle(MiloTheme.foreground)
                                    Spacer(minLength: 0)
                                    Image(systemName: "plus")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(MiloTheme.accent)
                                }
                                .padding(MiloTheme.Space.three)
                                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.md))
                            }
                            .buttonStyle(PressableStyle())
                            .disabled(busy)
                        }
                    }
                }
            }
            .padding(MiloTheme.Space.four)
            .miloGlassCard(radius: MiloTheme.Radius.lg)
        }
    }

    private var installedSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Installed")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            if model.installedSkills.isEmpty {
                VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                    Text("No skills installed.")
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                    Text("Add a skill by repository or install one from the popular directory below.")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MiloTheme.Space.four)
                .miloGlassCard(radius: MiloTheme.Radius.lg)
            } else {
                VStack(spacing: MiloTheme.Space.two) {
                    ForEach(model.installedSkills) { skill in
                        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
                            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                                Text(skill.name)
                                    .font(MiloTheme.Text.body.weight(.semibold))
                                    .foregroundStyle(MiloTheme.foreground)
                                Text(skill.origin.map { "\(skill.description) · \($0)" } ?? skill.description)
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                            MiloIconButton(systemName: "trash", size: 14, span: 36, glass: true) {
                                Task { await model.removeSkill(skill.name) }
                            }
                            .accessibilityLabel("Remove \(skill.name)")
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .miloGlassCard(radius: MiloTheme.Radius.lg)
                    }
                }
            }
        }
    }

    private var popularSection: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Text("Popular skills")
                .font(MiloTheme.Text.title)
                .foregroundStyle(MiloTheme.foreground)

            if model.popularSkillsLoading && model.popularSkills.isEmpty {
                HStack(spacing: MiloTheme.Space.two) {
                    ProgressView().controlSize(.small)
                    Text("Loading…")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                .padding(MiloTheme.Space.four)
                .frame(maxWidth: .infinity, alignment: .leading)
                .miloGlassCard(radius: MiloTheme.Radius.lg)
            } else if model.popularSkills.isEmpty {
                Text("Directory could not be reached.")
                    .font(MiloTheme.Text.small)
                    .foregroundStyle(MiloTheme.muted)
                    .padding(MiloTheme.Space.four)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .miloGlassCard(radius: MiloTheme.Radius.lg)
            } else {
                VStack(spacing: MiloTheme.Space.two) {
                    ForEach(model.popularSkills) { item in
                        let installed = model.installedSkills.contains { $0.name == item.name }
                        HStack(alignment: .center, spacing: MiloTheme.Space.three) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                    .font(MiloTheme.Text.body.weight(.semibold))
                                    .foregroundStyle(MiloTheme.foreground)
                                Text(popularSubtitle(item))
                                    .font(MiloTheme.Text.small)
                                    .foregroundStyle(MiloTheme.muted)
                                    .lineLimit(3)
                            }
                            Spacer(minLength: 0)
                            Button {
                                Task {
                                    busy = true
                                    defer { busy = false }
                                    _ = await model.installSkill(source: item.repo, skill: item.name)
                                }
                            } label: {
                                Text(installed ? "Installed" : "Install")
                                    .font(MiloTheme.Text.small.weight(.semibold))
                                    .foregroundStyle(installed ? MiloTheme.muted : MiloTheme.accentOn)
                                    .padding(.horizontal, MiloTheme.Space.three)
                                    .padding(.vertical, MiloTheme.Space.two)
                                    .background(installed ? MiloTheme.surface : MiloTheme.accent, in: Capsule())
                            }
                            .buttonStyle(PressableStyle())
                            .disabled(installed || busy)
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .miloGlassCard(radius: MiloTheme.Radius.lg)
                    }
                }
            }
        }
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
