import SwiftUI

/// Choosing the model: the providers this install can reach, then what each one
/// serves. The row leads with the size, because that is what tells two models of
/// the same family apart, and the slug is what is scanned.
///
/// A provider's catalog runs to hundreds of models, so the list is searched rather
/// than scrolled — the browser's own filter, reading the slug, the display name and
/// the daemon's shortened label the row is drawn with.
struct ModelPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var provider = ""
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Provider") {
                    ForEach(model.providers) { entry in
                        Button {
                            provider = entry.id
                            Task { await model.loadModels(from: entry.id) }
                        } label: {
                            HStack {
                                Text(entry.name).foregroundStyle(MiloTheme.foreground)
                                Spacer()
                                if entry.id == provider {
                                    Image(systemName: "checkmark").foregroundStyle(MiloTheme.accent)
                                }
                            }
                        }
                    }
                }

                Section("Model") {
                    if model.modelsLoading {
                        HStack(spacing: MiloTheme.Space.two) {
                            ProgressView().controlSize(.small)
                            Text("Reading the catalog…").foregroundStyle(MiloTheme.muted)
                        }
                    }
                    ForEach(matches) { entry in
                        Button {
                            Task {
                                await model.choose(entry.id)
                                dismiss()
                            }
                        } label: {
                            HStack(spacing: MiloTheme.Space.two) {
                                VStack(alignment: .leading, spacing: 2) {
                                    // Both lines come from the daemon, projected
                                    // from the one shortening every surface shares.
                                    Text(entry.title)
                                        .foregroundStyle(MiloTheme.foreground)
                                        .lineLimit(1)
                                    if let note = entry.note {
                                        Text(note)
                                            .font(MiloTheme.Text.meta)
                                            .foregroundStyle(MiloTheme.muted)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer(minLength: MiloTheme.Space.two)
                                if entry.id == model.modelName {
                                    Image(systemName: "checkmark").foregroundStyle(MiloTheme.accent)
                                }
                            }
                        }
                    }
                    // A list that came back with nothing says which nothing it is, rather
                    // than leaving the section blank under the field — and a refusal wears
                    // the tone a failure wears.
                    if matches.isEmpty && !model.modelsLoading {
                        Text(emptyLine)
                            .font(MiloTheme.Text.small)
                            .foregroundStyle(model.modelsError == nil ? MiloTheme.muted : MiloTheme.danger)
                    }
                }
            }
            // The platform's own search, over the list rather than in it: it filters the
            // catalog below and nothing else, and it is the field this surface already has —
            // in the material the platform draws it in.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter models")
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await model.openPicker()
            provider = model.providerId
        }
    }

    /// What the Model section draws: the whole catalog, or the part of it the field is
    /// asking for — the same three words the browser filters on.
    private var matches: [ModelInfo] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return model.models }
        return model.models.filter {
            "\($0.id) \($0.name ?? "") \($0.label ?? "")".lowercased().contains(needle)
        }
    }

    /// Why the section is empty: the reason the catalog never came, the field matching
    /// nothing in one that did, or a catalog that holds nothing at all — the browser's own
    /// words for the last.
    private var emptyLine: String {
        if let reason = model.modelsError { return reason }
        return model.models.isEmpty ? "No models found." : "No models match."
    }
}
