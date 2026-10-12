import SwiftUI

/// Choosing the model: the providers this install can reach, then what each one
/// serves. The row leads with the size, because that is what tells two models of
/// the same family apart, and the slug is what is scanned.
struct ModelPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var provider = ""

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
                    ForEach(model.models) { entry in
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
                }
            }
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
}
