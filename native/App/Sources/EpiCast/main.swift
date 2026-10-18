import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) { MediaFiles.cleanUp() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct EpiCastApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var workspace = Workspace()
    var body: some Scene {
        Window("EpiCast", id: "workspace") {
            WorkspaceView(workspace: workspace)
                .frame(minWidth: 900, minHeight: 650)
                .tint(Color.accentColor)
        }
        .defaultSize(width: 1160, height: 820)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Record Encounter") { workspace.selection = .intake }
                    .keyboardShortcut("n", modifiers: .command)
            }
            CommandMenu("Workspace") {
                ForEach(Array(Destination.allCases.enumerated()), id: \.element.id) { index, destination in
                    Button(destination.title) { workspace.selection = destination }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                }
                Divider()
                Button("Refresh Data") { Task { await workspace.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(workspace.refreshing)
            }
        }
        Settings { ConnectionSettings(workspace: workspace).frame(width: 480) }
    }
}

struct WorkspaceView: View {
    @ObservedObject var workspace: Workspace
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                Label("EpiCast", systemImage: "waveform.path.ecg")
                    .font(.title2.weight(.semibold)).padding(20)
                List(Destination.allCases, selection: $workspace.selection) { destination in
                    Label(destination.title, systemImage: destination.symbol).tag(destination)
                        .padding(.vertical, 5)
                }.listStyle(.sidebar)
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Label(workspace.health == nil ? "Server unavailable" : "Local API connected",
                          systemImage: workspace.health == nil ? "network.slash" : "externaldrive.connected.to.line.below")
                        .font(.callout.weight(.medium))
                    Text("Surveillance runs through your local API.")
                        .font(.caption).foregroundStyle(.secondary)
                    SettingsLink { Label("Connection settings", systemImage: "gearshape") }
                        .buttonStyle(.link).font(.caption)
                }.padding(18)
            }.navigationSplitViewColumnWidth(min: 215, ideal: 235, max: 270)
        } detail: {
            Group {
                switch workspace.selection ?? .overview {
                case .overview: OverviewView(workspace: workspace)
                case .alerts: AlertsView(workspace: workspace)
                case .intake: IntakeView(workspace: workspace)
                case .reports: ReportsView(workspace: workspace)
                }
            }
            .background(Color(nsColor: .windowBackgroundColor))
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    if workspace.refreshing { ProgressView().controlSize(.small).help("Refreshing surveillance data") }
                    else {
                        Button { Task { await workspace.refresh() } } label: { Label("Refresh data", systemImage: "arrow.clockwise") }
                    }
                }
            }
        }
        .task { await workspace.refresh() }
    }
}

struct ConnectionSettings: View {
    @ObservedObject var workspace: Workspace
    @State private var address = ""
    @State private var error = ""
    @State private var applying = false
    var body: some View {
        Form {
            Section("Local server") {
                TextField("API address", text: $address)
                    .textFieldStyle(.roundedBorder)
                Text("Start EpiCast Server on this Mac, then connect. Only localhost addresses are accepted.")
                    .font(.caption).foregroundStyle(.secondary)
                Button(applying ? "Connecting…" : "Apply and reconnect") {
                    applying = true; error = ""
                    Task {
                        do { try await workspace.configure(address) }
                        catch { self.error = error.localizedDescription }
                        applying = false
                    }
                }.disabled(applying || workspace.busy != nil || workspace.refreshing)
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
                if !workspace.connectionError.isEmpty { Text(workspace.connectionError).foregroundStyle(.red) }
            }
            if let health = workspace.health {
                Section("Model availability") {
                    LabeledContent("Application server", value: health.server_backend.map(readable) ?? "Unspecified")
                    ForEach(["text", "transcription", "image", "cough"], id: \.self) { name in
                        LabeledContent(readable(name), value: health.artifacts_present[name] == true ? "Artifact present" : "Not provisioned")
                    }
                    Text(health.readiness_note).font(.caption).foregroundStyle(.secondary)
                    LabeledContent("Release validation", value: health.release_validated ? "Passed" : "Incomplete")
                    LabeledContent("Inference queue", value: "\(health.runtime.queue_depth) / \(health.runtime.queue_capacity)")
                    if let error = health.runtime.last_error, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    }
                }
            }
        }.formStyle(.grouped).padding().onAppear { address = workspace.serverAddress }
    }
}
