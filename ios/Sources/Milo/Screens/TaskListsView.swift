import SwiftUI

/**
 The task lists surface, drawn beside the chat and the routines: the lists on the front
 page, and one list's own page — its tasks to tick off and its name to change — one level
 in. Everything lives in the daemon's store, so every action reads the whole set back
 rather than guessing at what it became.
 */
struct TaskListsView: View {
    /// Whether one list's own page is open on top of the index, told to the shell: the
    /// drawer's swipe belongs to the index, and a page answers the same drag with the way back.
    @Binding var pushed: Bool
    /// Opening the sessions from here. The drawer belongs to the chat, and this screen
    /// reaches it through the same control and the same swipe.
    let onSessions: () -> Void
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []

    /// Where the platform's own back gesture picks up: a drag that starts this close to the
    /// screen's edge is the system's to answer, so this screen's own one keeps out of it.
    private static let edge: CGFloat = 24

    var body: some View {
        NavigationStack(path: $path) {
            TaskListIndex(
                onSelect: { path.append($0) },
                onSessions: onSessions
            )
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { listId in
                TaskListDetail(
                    listId: listId,
                    onDeleted: { path.removeAll { $0 == listId } }
                )
            }
        }
        // A drag across a list's own page is the way back to the index — the same drag that
        // opens the sessions from the index itself, answering where the person is standing.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24, coordinateSpace: .global)
                .onEnded { drag in
                    let across = drag.translation.width
                    guard abs(across) > abs(drag.translation.height) * 1.5 else { return }
                    guard !path.isEmpty, across > 60, drag.startLocation.x > Self.edge else { return }
                    path.removeLast()
                }
        )
        .onChange(of: path) { _, next in pushed = !next.isEmpty }
        // A chat turn may have changed a list through Milo; re-read its persisted state.
        .onChange(of: model.answerEnded) { _, _ in
            Task { await model.refreshTaskLists() }
        }
        .onAppear {
            pushed = !path.isEmpty
        }
    }
}

// MARK: - The index

private struct TaskListIndex: View {
    let onSelect: (String) -> Void
    let onSessions: () -> Void

    @Environment(AppModel.self) private var model
    @State private var newName = ""
    @State private var renaming: TaskList?
    @State private var renameDraft = ""
    @State private var deleting: TaskList?
    @FocusState private var creating: Bool

    private var openCount: Int {
        model.taskLists.reduce(0) { $0 + $1.openCount }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    HStack(spacing: MiloTheme.Space.two) {
                        Image(systemName: "checklist")
                            .font(.system(size: 13, weight: .semibold))
                        Text("WORKSPACE")
                            .font(MiloTheme.Text.meta.weight(.semibold))
                            .tracking(1.1)
                    }
                    .foregroundStyle(MiloTheme.accent)

                    Text("Task lists")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(MiloTheme.foreground)
                    Text("Keep the things you and Milo are working on, together across sessions.")
                        .font(MiloTheme.Text.body)
                        .foregroundStyle(MiloTheme.muted)

                    HStack(spacing: MiloTheme.Space.two) {
                        Label("\(openCount) open", systemImage: "circle")
                        Text("·").foregroundStyle(MiloTheme.muted)
                        Text("\(model.taskLists.count) \(model.taskLists.count == 1 ? "list" : "lists")")
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .font(MiloTheme.Text.small.weight(.medium))
                    .padding(.top, MiloTheme.Space.one)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MiloTheme.Space.five)
                .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.xl))

                if let error = model.taskListsError {
                    MiloErrorPill(text: error)
                }

                VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                    Text("Your lists")
                        .font(MiloTheme.Text.title)
                        .foregroundStyle(MiloTheme.foreground)

                    if model.taskLists.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                            Image(systemName: model.taskListsLoading ? "hourglass" : "checklist")
                                .font(.system(size: 22, weight: .medium))
                                .foregroundStyle(MiloTheme.accent)
                            Text(model.taskListsLoading ? "Reading your task lists…" : "No task lists yet")
                                .font(MiloTheme.Text.body.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("Create a list for a project, an idea, or anything else you want Milo to keep track of with you.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.five)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else {
                        VStack(spacing: MiloTheme.Space.two) {
                            ForEach(model.taskLists) { list in
                                TaskListRow(
                                    list: list,
                                    onOpen: { onSelect(list.id) },
                                    onRename: {
                                        renameDraft = list.name
                                        renaming = list
                                    },
                                    onDelete: { deleting = list }
                                )
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.four)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(MiloTheme.background)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: MiloTheme.Space.one) {
                HStack(spacing: 0) {
                    SessionsButton(action: onSessions)
                    Spacer(minLength: 0)
                }
                ConnectionPill()
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.bottom, MiloTheme.Space.two)
            .animation(.smooth(duration: 0.22), value: model.connectionLine)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            createBar
        }
        .refreshable {
            await model.refreshTaskLists()
        }
        .task { await model.refreshTaskLists() }
        .alert(
            "Rename list",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
        ) {
            TextField("List name", text: $renameDraft)
            Button("Save") {
                if let list = renaming {
                    let next = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !next.isEmpty, next != list.name {
                        Task { await model.renameTaskList(name: list.name, newName: next) }
                    }
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog(
            "Delete “\(deleting?.name ?? "")” and its tasks?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let list = deleting {
                    Task { await model.deleteTaskList(name: list.name) }
                }
                deleting = nil
            }
        }
    }

    private var canCreate: Bool {
        !newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.taskListsSaving
    }

    private var createBar: some View {
        HStack(alignment: .center, spacing: MiloTheme.Space.two) {
            TextField("New list name", text: $newName)
                .focused($creating)
                .font(.body)
                .foregroundStyle(MiloTheme.foreground)
                .submitLabel(.done)
                .onSubmit(submitNewList)
                .padding(.leading, MiloTheme.Space.three)
                .padding(.vertical, MiloTheme.Space.two + 2)

            MiloIconButton(
                systemName: "plus",
                size: 16,
                span: 36,
                primary: true,
                disabled: !canCreate,
                action: submitNewList
            )
            .accessibilityLabel("Create list")
        }
        .padding(.horizontal, MiloTheme.Space.two)
        .padding(.vertical, MiloTheme.Space.one)
        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, MiloTheme.margin)
        .padding(.bottom, MiloTheme.Space.two)
        .padding(.top, MiloTheme.Space.one)
    }

    private func submitNewList() {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !model.taskListsSaving else { return }
        newName = ""
        creating = false
        Task { await model.createTaskList(name: trimmed) }
    }
}

private struct TaskListRow: View {
    let list: TaskList
    let onOpen: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void

    private var meta: String {
        let total = list.items.count
        if total == 0 { return "No tasks yet" }
        let count = "\(total) \(total == 1 ? "task" : "tasks")"
        return "\(count) · last added \(RelativeTime.when(list.lastActivity))"
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: MiloTheme.Space.three) {
                VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                    Text(list.name)
                        .font(MiloTheme.Text.body.weight(.semibold))
                        .foregroundStyle(MiloTheme.foreground)
                        .lineLimit(1)
                    Text(meta)
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: MiloTheme.Space.two)
                HStack(spacing: MiloTheme.Space.one) {
                    Text("\(list.openCount)")
                        .font(MiloTheme.Text.base.weight(.semibold).monospacedDigit())
                        .foregroundStyle(list.openCount > 0 ? MiloTheme.accent : MiloTheme.muted)
                    Text("open")
                        .font(MiloTheme.Text.small)
                        .foregroundStyle(MiloTheme.muted)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MiloTheme.muted)
            }
            .padding(MiloTheme.Space.four)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
            .contentShape(RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        }
        .buttonStyle(PressableStyle())
        .contextMenu {
            menuItem("Rename", "pencil", action: onRename)
            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
            .tint(Color(.systemRed))
        }
    }
}

// MARK: - One task list

private struct TaskListDetail: View {
    let listId: String
    let onDeleted: () -> Void

    @Environment(AppModel.self) private var model
    @State private var newTask = ""
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var confirmDelete = false
    @FocusState private var adding: Bool

    private static let control: CGFloat = 46

    private var list: TaskList? {
        model.taskLists.first { $0.id == listId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MiloTheme.Space.six) {
                if let list {
                    let todo = list.items.filter { !$0.completed }
                    let completed = list.items.filter(\.completed)

                    VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                        Text(list.name)
                            .font(MiloTheme.Text.title)
                            .foregroundStyle(MiloTheme.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(list.items.isEmpty ? "No tasks yet" : "\(todo.count) open · \(completed.count) completed")
                            .font(MiloTheme.Text.base)
                            .foregroundStyle(MiloTheme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MiloTheme.Space.five)
                    .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))

                    HStack(spacing: MiloTheme.Space.two) {
                        Button {
                            renameDraft = list.name
                            renaming = true
                        } label: {
                            Label("Rename", systemImage: "pencil")
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.foreground)
                                .frame(maxWidth: .infinity)
                                .frame(height: Self.control)
                                .contentShape(Capsule())
                        }
                        .disabled(model.taskListsSaving)
                        .buttonStyle(PressableStyle())
                        .glassEffect(.regular.interactive(), in: Capsule())

                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                                .font(MiloTheme.Text.base.weight(.semibold))
                                .foregroundStyle(MiloTheme.danger)
                                .frame(maxWidth: .infinity)
                                .frame(height: Self.control)
                                .contentShape(Capsule())
                        }
                        .disabled(model.taskListsSaving)
                        .buttonStyle(PressableStyle())
                        .glassEffect(.regular.tint(MiloTheme.danger.opacity(0.28)).interactive(), in: Capsule())
                    }

                    if let error = model.taskListsError {
                        MiloErrorPill(text: error)
                    }

                    if list.items.isEmpty {
                        VStack(alignment: .leading, spacing: MiloTheme.Space.two) {
                            Label("No tasks yet", systemImage: "checklist")
                                .font(MiloTheme.Text.body.weight(.medium))
                                .foregroundStyle(MiloTheme.foreground)
                            Text("This list is ready when you are. Add a task below, or ask Milo to remember one for you.")
                                .font(MiloTheme.Text.small)
                                .foregroundStyle(MiloTheme.muted)
                        }
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                    } else {
                        if !todo.isEmpty {
                            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                                Text("To do · \(todo.count)")
                                    .font(MiloTheme.Text.title)
                                    .foregroundStyle(MiloTheme.foreground)
                                VStack(spacing: MiloTheme.Space.two) {
                                    ForEach(todo) { item in
                                        TaskRow(
                                            item: item,
                                            disabled: model.taskListsSaving,
                                            onComplete: {
                                                Task { await model.completeTaskItem(listName: list.name, itemId: item.id) }
                                            },
                                            onRemove: {
                                                Task { await model.removeTaskItem(listName: list.name, itemId: item.id) }
                                            }
                                        )
                                    }
                                }
                            }
                        }

                        if !completed.isEmpty {
                            VStack(alignment: .leading, spacing: MiloTheme.Space.three) {
                                Text("Completed · \(completed.count)")
                                    .font(MiloTheme.Text.title)
                                    .foregroundStyle(MiloTheme.foreground)
                                VStack(spacing: MiloTheme.Space.two) {
                                    ForEach(completed) { item in
                                        TaskRow(
                                            item: item,
                                            disabled: model.taskListsSaving,
                                            onComplete: nil,
                                            onRemove: {
                                                Task { await model.removeTaskItem(listName: list.name, itemId: item.id) }
                                            }
                                        )
                                    }
                                }
                            }
                        }
                    }
                } else {
                    Text("This list is gone.")
                        .font(MiloTheme.Text.base)
                        .foregroundStyle(MiloTheme.muted)
                        .padding(MiloTheme.Space.four)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
                }
            }
            .padding(.horizontal, MiloTheme.margin)
            .padding(.top, MiloTheme.Space.four)
            .padding(.bottom, MiloTheme.Space.six)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(MiloTheme.background)
        .navigationTitle(list?.name ?? "Task list")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            ConnectionPill()
                .padding(.horizontal, MiloTheme.margin)
                .padding(.bottom, model.connectionLine == nil ? 0 : MiloTheme.Space.two)
                .animation(.smooth(duration: 0.22), value: model.connectionLine)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let list {
                addTaskBar(for: list)
            }
        }
        .alert("Rename list", isPresented: $renaming) {
            TextField("List name", text: $renameDraft)
            Button("Save") {
                guard let list else { return }
                let next = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !next.isEmpty, next != list.name else { return }
                Task { await model.renameTaskList(name: list.name, newName: next) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Delete “\(list?.name ?? "")” and its tasks?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                guard let list else { return }
                Task {
                    if await model.deleteTaskList(name: list.name) {
                        onDeleted()
                    }
                }
            }
        }
    }

    private var canAdd: Bool {
        !newTask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.taskListsSaving
    }

    private func addTaskBar(for list: TaskList) -> some View {
        HStack(alignment: .center, spacing: MiloTheme.Space.two) {
            TextField("Add something to this list…", text: $newTask, axis: .vertical)
                .lineLimit(1...4)
                .focused($adding)
                .font(.body)
                .foregroundStyle(MiloTheme.foreground)
                .padding(.leading, MiloTheme.Space.three)
                .padding(.vertical, MiloTheme.Space.two + 2)

            MiloIconButton(
                systemName: "plus",
                size: 16,
                span: 36,
                primary: true,
                disabled: !canAdd,
                action: { submitTask(to: list) }
            )
            .accessibilityLabel("Add task")
        }
        .padding(.horizontal, MiloTheme.Space.two)
        .padding(.vertical, MiloTheme.Space.one)
        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, MiloTheme.margin)
        .padding(.bottom, MiloTheme.Space.two)
        .padding(.top, MiloTheme.Space.one)
    }

    private func submitTask(to list: TaskList) {
        let content = newTask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !model.taskListsSaving else { return }
        newTask = ""
        adding = false
        Task { await model.addTaskItem(listName: list.name, item: content) }
    }
}

private struct TaskRow: View {
    let item: TaskListItem
    let disabled: Bool
    let onComplete: (() -> Void)?
    let onRemove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: MiloTheme.Space.three) {
            if let onComplete, !item.completed {
                Button(action: onComplete) {
                    Image(systemName: "circle")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(MiloTheme.muted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .disabled(disabled)
                .accessibilityLabel("Complete \(item.content)")
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(MiloTheme.success)
                    .frame(width: 28, height: 28)
                    .accessibilityLabel("Completed")
            }

            VStack(alignment: .leading, spacing: MiloTheme.Space.one) {
                Text(item.content)
                    .font(MiloTheme.Text.body)
                    .foregroundStyle(item.completed ? MiloTheme.muted : MiloTheme.foreground)
                    .strikethrough(item.completed, color: MiloTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text(RelativeTime.when(item.createdAt))
                    .font(MiloTheme.Text.meta)
                    .foregroundStyle(MiloTheme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)

            Button(action: onRemove) {
                Image(systemName: "trash")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(MiloTheme.muted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .disabled(disabled)
            .accessibilityLabel("Remove \(item.content)")
        }
        .padding(MiloTheme.Space.three)
        .background(MiloTheme.surface, in: RoundedRectangle(cornerRadius: MiloTheme.Radius.lg))
        .contextMenu {
            menuItem("Copy", "doc.on.doc") { UIPasteboard.general.string = item.content }
            if let onComplete, !item.completed {
                menuItem("Complete", "checkmark.circle", disabled: disabled, action: onComplete)
            }
            Button(role: .destructive, action: onRemove) {
                Label("Remove", systemImage: "trash")
            }
            .tint(Color(.systemRed))
            .disabled(disabled)
        }
    }
}

