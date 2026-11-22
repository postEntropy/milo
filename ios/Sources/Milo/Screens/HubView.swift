import SwiftUI

/// The Hub tab: a grid of Milo's workspace destinations that can be opened directly
/// or pinned to the bottom tab bar with a tap-and-hold.
struct HubView: View {
    let account: Account
    let pinnedStore: PinnedTabsStore
    @Binding var path: NavigationPath
    let onOpenSettings: () -> Void
    let onOpenChat: () -> Void

    @Environment(AppModel.self) private var model
    @State private var cardWidth: CGFloat = 170
    @State private var reordering = false

    private let columns = [
        GridItem(.flexible(), spacing: MiloTheme.Space.three),
        GridItem(.flexible(), spacing: MiloTheme.Space.three),
    ]

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: MiloTheme.Space.four) {
                    Text(pinnedStore.items.count > 1
                         ? "Tap and hold an item to pin or reorder"
                         : "Tap and hold an item to pin it to the tab bar")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, MiloTheme.Space.one)

                    LazyVGrid(columns: columns, spacing: MiloTheme.Space.three) {
                        ForEach(HubItem.allCases) { item in
                            hubCard(item)
                        }
                    }
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.top, MiloTheme.Space.two)
                .padding(.bottom, MiloTheme.Space.six)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .miloWallpaperBackground()
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: MiloTheme.Space.one) {
                    HStack(spacing: MiloTheme.Space.two) {
                        Spacer(minLength: 0)
                        if pinnedStore.items.count > 1 {
                            Button {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                reordering = true
                            } label: {
                                Image(systemName: "arrow.left.arrow.right")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(MiloTheme.foreground)
                                    .frame(width: 30, height: 30)
                            }
                            .buttonStyle(.glass)
                            .buttonBorderShape(.circle)
                            .controlSize(.regular)
                            .tint(MiloTheme.foreground)
                            .accessibilityLabel("Reorder tab bar")
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                        }
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            onOpenSettings()
                        } label: {
                            Image(systemName: "gearshape")
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .controlSize(.regular)
                        .tint(MiloTheme.foreground)
                        .accessibilityLabel("Settings")
                    }
                    .frame(minHeight: 46)
                    .animation(.smooth(duration: 0.2), value: pinnedStore.items.count > 1)
                    ConnectionPill()
                }
                .padding(.horizontal, MiloTheme.margin)
                .padding(.bottom, MiloTheme.Space.two)
                .animation(.smooth(duration: 0.22), value: model.connectionLine)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: HubItem.self) { item in
                destination(for: item)
            }
            .navigationDestination(for: RoutinesView.Route.self) { route in
                RoutinesView.destination(for: route)
            }
            .sheet(isPresented: $reordering) {
                ReorderPinnedTabsSheet(pinnedStore: pinnedStore)
            }
        }
    }

    private func hubCard(_ item: HubItem) -> some View {
        let pinned = pinnedStore.contains(item)

        return hubCardContent(item, pinned: pinned)
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .miloGlassCard(radius: MiloTheme.Radius.xl, tint: MiloTheme.background.opacity(0.22))
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                if width > 0 { cardWidth = width }
            }
            .onTapGesture {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                path.append(item)
            }
            .contextMenu {
                Button {
                    path.append(item)
                } label: {
                    Label("Open \(item.title)", systemImage: "arrow.up.right")
                }

                if pinned {
                    if pinnedStore.canMoveLeft(item) {
                        Button {
                            pinnedStore.moveLeft(item)
                        } label: {
                            Label("Move left", systemImage: "arrow.left")
                        }
                    }

                    if pinnedStore.canMoveRight(item) {
                        Button {
                            pinnedStore.moveRight(item)
                        } label: {
                            Label("Move right", systemImage: "arrow.right")
                        }
                    }

                    Button {
                        pinnedStore.unpin(item)
                    } label: {
                        Label("Unpin from tab bar", systemImage: "pin.slash")
                    }
                } else if pinnedStore.canPinMore {
                    Button {
                        pinnedStore.pin(item)
                    } label: {
                        Label("Pin to tab bar", systemImage: "pin")
                    }
                } else {
                    Menu {
                        ForEach(pinnedStore.items) { existing in
                            Button("Replace \(existing.title)") {
                                pinnedStore.replace(existing, with: item)
                            }
                        }
                    } label: {
                        Label("Replace a pinned tab", systemImage: "pin")
                    }
                }
            } preview: {
                hubCardContent(item, pinned: pinned)
                    .padding(MiloTheme.Space.four)
                    .frame(width: cardWidth, alignment: .leading)
                    .background(MiloTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))
            }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(item.title)
            .accessibilityValue(pinned ? "Pinned to tab bar" : "")
    }

    private func hubCardContent(_ item: HubItem, pinned: Bool) -> some View {
        VStack(alignment: .leading, spacing: MiloTheme.Space.five) {
            HStack(alignment: .center, spacing: MiloTheme.Space.two) {
                Text(item.title)
                    .font(MiloTheme.Text.body.weight(.semibold))
                    .foregroundStyle(MiloTheme.foreground)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if pinned {
                    Image(systemName: "pin")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(MiloTheme.accent)
                }
            }

            HStack {
                Group {
                    if item == .crew {
                        CrewDrawerMark(size: 20)
                    } else {
                        Image(systemName: item.symbol)
                            .font(.system(size: 17, weight: .semibold))
                    }
                }
                .foregroundStyle(item.tint)
                .frame(width: 36, height: 36)
                .background(item.tint.opacity(0.16), in: Circle())
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func destination(for item: HubItem) -> some View {
        switch item {
        case .routines:
            RoutinesView(account: account, path: $path, embeddedInHub: true)
        case .crew:
            CrewView(
                account: account,
                externalPath: $path,
                onChatWithBot: { botId in
                    Task {
                        if await model.startBotSession(botId: botId) {
                            path = NavigationPath()
                            onOpenChat()
                        }
                    }
                }
            )
        case .taskLists:
            TaskListsView(externalPath: $path)
        case .analytics:
            AnalyticsView(account: account, externalPath: $path)
        case .folders:
            FoldersView(externalPath: $path) {
                path = NavigationPath()
                onOpenChat()
            }
        case .memory:
            MemoryView(embeddedInHub: true) { id in
                Task {
                    if await model.resume(id) {
                        path = NavigationPath()
                        onOpenChat()
                    }
                }
            }
        case .skills:
            SkillsView(embeddedInHub: true)
        }
    }
}

private struct ReorderPinnedTabsSheet: View {
    let pinnedStore: PinnedTabsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(pinnedStore.items) { item in
                        HStack(spacing: MiloTheme.Space.three) {
                            Group {
                                if item == .crew {
                                    CrewDrawerMark(size: 18)
                                } else {
                                    Image(systemName: item.symbol)
                                        .font(.system(size: 15, weight: .semibold))
                                }
                            }
                            .foregroundStyle(item.tint)
                            .frame(width: 32, height: 32)
                            .background(item.tint.opacity(0.16), in: Circle())

                            Text(item.title)
                                .font(MiloTheme.Text.body.weight(.medium))
                                .foregroundStyle(MiloTheme.foreground)
                        }
                        .padding(.vertical, 2)
                    }
                    .onMove { source, destination in
                        pinnedStore.move(fromOffsets: source, toOffset: destination)
                    }
                    .onDelete { offsets in
                        for index in offsets.sorted(by: >) {
                            pinnedStore.unpin(pinnedStore.items[index])
                        }
                    }
                } header: {
                    Text("Pinned tabs")
                } footer: {
                    Text("Chat stays first and Hub stays last. Drag handles to reorder or remove a pinned tab.")
                }
            }
            .environment(\.editMode, .constant(.active))
            .scrollContentBackground(.hidden)
            .miloWallpaperBackground()
            .navigationTitle("Tab bar order")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: pinnedStore.items.isEmpty) { _, empty in
                if empty { dismiss() }
            }
        }
        .tint(MiloTheme.accent)
        .presentationDetents([.medium])
        .presentationBackground(MiloTheme.background)
    }
}
