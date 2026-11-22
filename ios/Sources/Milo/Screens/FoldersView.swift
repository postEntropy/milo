import SwiftUI

/// Remembered host folders, with inspection for files, git changes, and rules, plus
/// one-tap Session creation inside any folder.
struct FoldersView: View {
    var externalPath: Binding<NavigationPath>? = nil
    let onOpenChat: () -> Void

    @Environment(AppModel.self) private var model
    @State private var localPath = NavigationPath()
    @State private var picking = false

    private enum Route: Hashable {
        case detail(String)
    }

    var body: some View {
        Group {
            if externalPath != nil {
                content
            } else {
                NavigationStack(path: $localPath) {
                    content
                }
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                heroCard

                if let error = model.projectsError {
                    MiloErrorPill(text: error)
                }

                if model.projects.isEmpty {
                    emptyCard
                } else {
                    VStack(spacing: MiloTheme.Space.two) {
                        ForEach(model.projects) { project in
                            folderRow(project)
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six + 56)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .miloWallpaperBackground()
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.connectionLine != nil {
                ConnectionPill()
                    .padding(.horizontal, MiloTheme.margin)
                    .padding(.bottom, MiloTheme.Space.two)
                    .animation(.smooth(duration: 0.22), value: model.connectionLine)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            MiloCornerActionButton(
                title: "Choose folder",
                systemImage: "folder.badge.plus",
                disabled: model.projectsSaving
            ) {
                picking = true
            }
        }
        .toolbar(externalPath != nil ? .visible : .hidden, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: Route.self) { route in
            switch route {
            case .detail(let id):
                FolderDetailView(projectId: id, onOpenChat: onOpenChat)
                    .toolbarVisibility(.hidden, for: .tabBar)
            }
        }
        .sheet(isPresented: $picking) {
            FolderPicker { path in
                picking = false
                Task { await model.createProject(folder: path) }
            }
        }
        .refreshable { await model.refreshProjects() }
        .task { await model.refreshProjects() }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            HStack(spacing: MiloTheme.Space.two) {
                Image(systemName: "folder")
                    .font(.system(size: 13, weight: .semibold))
                Text("WORKSPACE")
                    .font(MiloTheme.Text.meta.weight(.semibold))
                    .tracking(1.1)
            }
            .foregroundStyle(MiloTheme.accent)

            Text("Folders")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(MiloTheme.foreground)

            Text("Inspect host files, git changes, and rules, or open a Session directly in a folder.")
                .font(MiloTheme.Text.body)
                .foregroundStyle(MiloTheme.muted)

            Text("\(model.projects.count) \(model.projects.count == 1 ? "folder" : "folders")")
                .font(MiloTheme.Text.small.weight(.medium))
                .foregroundStyle(MiloTheme.muted)
                .padding(.top, MiloTheme.Space.one)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.five)
        .miloGlassCard(radius: MiloTheme.Radius.xl)
    }

    private var emptyCard: some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
            Image(systemName: "folder")
                .font(.title2)
                .foregroundStyle(MiloTheme.accent)
            Text("No recent folders")
                .font(MiloTheme.Text.body.weight(.semibold))
                .foregroundStyle(MiloTheme.foreground)
            Text("Choose a folder on the host machine to browse its files, git changes, and AGENTS.md rules.")
                .font(MiloTheme.Text.small)
                .foregroundStyle(MiloTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MiloTheme.Space.five)
        .miloGlassCard(radius: MiloTheme.Radius.lg)
    }

    private func folderRow(_ project: Project) -> some View {
        Button {
            if let externalPath {
                externalPath.wrappedValue.append(Route.detail(project.id))
            } else {
                localPath.append(Route.detail(project.id))
            }
        } label: {
            HStack(spacing: MiloTheme.Space.three) {
                Image(systemName: ProjectMark.symbol(project.icon))
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(project.error == nil ? MiloTheme.accent : MiloTheme.danger)
                    .frame(width: 34, height: 34)
                    .background(
                        (project.error == nil ? MiloTheme.accent : MiloTheme.danger).opacity(0.15),
                        in: Circle()
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                    Text(project.error ?? project.path)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(project.error == nil ? MiloTheme.muted : MiloTheme.danger)
                        .lineLimit(2)
                        .truncationMode(.head)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.mutedStrong)
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .miloGlassCard(radius: MiloTheme.Radius.lg, interactive: true)
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        }
        .buttonStyle(PressableStyle())
    }
}

private struct FolderDetailView: View {
    let projectId: String
    let onOpenChat: () -> Void

    @Environment(AppModel.self) private var model
    @State private var startingSession = false

    private var project: Project? {
        model.projects.first { $0.id == projectId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let project {
                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        HStack(spacing: MiloTheme.Space.three) {
                            Image(systemName: ProjectMark.symbol(project.icon))
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(MiloTheme.accent)
                                .frame(width: 38, height: 38)
                                .background(MiloTheme.accent.opacity(0.15), in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.name)
                                    .font(MiloTheme.Text.title)
                                    .foregroundStyle(MiloTheme.foreground)
                                Text(project.path)
                                    .font(MiloTheme.Text.meta.monospaced())
                                    .foregroundStyle(MiloTheme.muted)
                                    .lineLimit(2)
                            }
                        }

                        if let error = project.error {
                            MiloErrorPill(text: error)
                        } else {
                            Button {
                                guard !startingSession else { return }
                                startingSession = true
                                Task {
                                    let opened = await model.startWorkSession(project: project.id, confirmed: true)
                                    startingSession = false
                                    if opened { onOpenChat() }
                                }
                            } label: {
                                HStack(spacing: MiloTheme.Space.two) {
                                    if startingSession {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Image(systemName: "bubble.left.and.bubble.right")
                                            .font(.system(size: 14, weight: .semibold))
                                    }
                                    Text(startingSession ? "Opening…" : "New session here")
                                        .font(MiloTheme.Text.base.weight(.semibold))
                                }
                                .foregroundStyle(MiloTheme.accentOn)
                                .padding(.horizontal, MiloTheme.Space.four)
                                .padding(.vertical, MiloTheme.Space.two + 2)
                                .background(MiloTheme.accent, in: Capsule())
                            }
                            .buttonStyle(PressableStyle())
                            .disabled(startingSession)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.four)
                    .miloGlassCard(radius: MiloTheme.Radius.xl)

                    if project.error == nil {
                        ProjectFiles(projectId: project.id)
                        ProjectChanges(projectId: project.id)
                        ProjectRulesSection(projectId: project.id) { prompt in
                            guard !startingSession else { return }
                            startingSession = true
                            Task {
                                let opened = await model.startWorkSession(project: project.id, confirmed: true)
                                startingSession = false
                                if opened {
                                    model.send(prompt)
                                    onOpenChat()
                                }
                            }
                        }
                    }
                } else {
                    Text("Folder not found.")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)
                        .padding(MiloTheme.Space.five)
                        .miloGlassCard()
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .miloWallpaperBackground()
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.connectionLine != nil {
                ConnectionPill()
                    .padding(.horizontal, MiloTheme.margin)
                    .padding(.bottom, MiloTheme.Space.two)
                    .animation(.smooth(duration: 0.22), value: model.connectionLine)
            }
        }
        .navigationTitle(project?.name ?? "Folder")
        .navigationBarTitleDisplayMode(.inline)
    }
}
