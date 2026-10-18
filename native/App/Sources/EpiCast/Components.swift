import SwiftUI

struct PageHeading: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 28, weight: .semibold))
            Text(subtitle).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct Surface<Content: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let content: Content
    init(_ title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title; self.subtitle = subtitle; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                if let subtitle { Text(subtitle).font(.callout).foregroundStyle(.secondary) }
            }
            content
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.1)))
    }
}
struct MessageBanner: View {
    let message: String
    var error = false
    var body: some View {
        Label(message, systemImage: error ? "exclamationmark.triangle" : "checkmark.circle")
            .font(.callout).foregroundStyle(error ? Color.red : Color.primary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background((error ? Color.red : Color.accentColor).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .combine)
    }
}
struct EmptyState: View {
    let title: String
    let detail: String
    let symbol: String
    var body: some View {
        ContentUnavailableView { Label(title, systemImage: symbol) } description: { Text(detail) }
            .frame(maxWidth: .infinity).padding(.vertical, 20)
    }
}
struct SeverityBadge: View {
    let level: String
    private var color: Color {
        switch level {
        case "emergency", "critical", "severe": .red
        case "warning", "moderate": .orange
        default: .blue
        }
    }
    var body: some View {
        Label(readable(level), systemImage: level == "emergency" ? "exclamationmark.octagon" : "circle.fill")
            .font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(color.opacity(0.1), in: Capsule())
    }
}
struct ProvenanceView: View {
    let provenance: Provenance
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text([provenance.model, provenance.backend, provenance.location].compactMap { $0 }.joined(separator: " · "))
            if let revision = provenance.revision { Text("Revision \(revision)").textSelection(.enabled) }
        }.font(.caption).foregroundStyle(.secondary)
    }
}
struct OperationFeedback: View {
    @ObservedObject var workspace: Workspace
    let destination: Destination
    var body: some View {
        if workspace.busy == destination {
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                Text(workspace.cancelling ? "Cancelling…" : workspace.jobStatus)
                Spacer()
                if workspace.canCancelJob {
                    Button("Cancel", action: workspace.cancel).disabled(workspace.cancelling)
                }
            }.padding(.vertical, 8).accessibilityElement(children: .contain)
        }
        if workspace.operationDestination == destination && !workspace.operationError.isEmpty { MessageBanner(message: workspace.operationError, error: true) }
        if workspace.operationDestination == destination && !workspace.notice.isEmpty { MessageBanner(message: workspace.notice) }
        if let other = workspace.busy, other != destination {
            Text("\(other.title) is using inference. You can keep browsing while it finishes.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }
}
