import SwiftUI

struct AlertsView: View {
    @ObservedObject var workspace: Workspace
    @State private var query = ""
    @State private var level = "all"
    private var filtered: [SurveillanceAlert] {
        workspace.alerts.filter { alert in
            (level == "all" || alert.alert_level == level) &&
            (query.isEmpty || "\(alert.district) \(readable(alert.syndrome_category)) \(alert.situation_summary)".localizedCaseInsensitiveContains(query))
        }.sorted {
            let ranks = ["emergency": 0, "warning": 1, "watch": 2]
            if $0.alert_level != $1.alert_level { return ranks[$0.alert_level, default: 3] < ranks[$1.alert_level, default: 3] }
            return $0.timestamp > $1.timestamp
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(title: "Active alerts", subtitle: "Review anomalies detected by statistical surveillance.")
                if !workspace.alertsError.isEmpty {
                    MessageBanner(message: "Unable to refresh alerts. \(workspace.alertsError)", error: true)
                }
                HStack {
                    TextField("Search district or syndrome", text: $query).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Search alerts")
                    Picker("Alert level", selection: $level) {
                        Text("All levels").tag("all")
                        Text("Emergency").tag("emergency")
                        Text("Warning").tag("warning")
                        Text("Watch").tag("watch")
                    }.frame(width: 180)
                }
                if workspace.refreshing && workspace.alerts.isEmpty {
                    ProgressView("Loading alerts…").frame(maxWidth: .infinity, minHeight: 200)
                } else if workspace.alerts.isEmpty {
                    EmptyState(title: workspace.alertsError.isEmpty ? "No active alerts" : "Alerts unavailable",
                        detail: workspace.alertsError.isEmpty ? "The surveillance API returned no active anomalies." : "Reconnect to the local API and refresh.", symbol: "bell.slash")
                } else if filtered.isEmpty {
                    EmptyState(title: "No matching alerts", detail: "Try another district, syndrome or alert level.", symbol: "magnifyingglass")
                    Button("Clear filters") { query = ""; level = "all" }
                } else {
                    Text("\(filtered.count) of \(workspace.alerts.count) alerts").font(.caption).foregroundStyle(.secondary)
                    ForEach(filtered) { alert in AlertRow(alert: alert) }
                }
            }.padding(28).frame(maxWidth: 1100)
        }.navigationTitle("Active alerts")
    }
}

struct AlertRow: View {
    let alert: SurveillanceAlert
    var body: some View {
        Surface(readable(alert.syndrome_category), subtitle: alert.district) {
            HStack(alignment: .top) {
                SeverityBadge(level: alert.alert_level)
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("\(alert.case_count_current_week) observed cases").font(.headline)
                    Text(displayDate(alert.timestamp)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if !alert.situation_summary.isEmpty { Text(alert.situation_summary).textSelection(.enabled) }
            DisclosureGroup("Review evidence") {
                VStack(alignment: .leading, spacing: 12) {
                    LabeledContent("Baseline cases", value: alert.case_count_baseline.formatted(.number.precision(.fractionLength(1))))
                    LabeledContent("Ratio to baseline", value: alert.ratio_to_baseline.formatted(.number.precision(.fractionLength(2))))
                    LabeledContent("Trend", value: readable(alert.trend))
                    LabeledContent("Weeks above threshold", value: alert.weeks_above_threshold.formatted())
                    if !alert.evidence_summary.isEmpty { Text(alert.evidence_summary).textSelection(.enabled) }
                    if !alert.recommended_actions.isEmpty {
                        Text("Recommended actions · Draft").font(.headline)
                        ForEach(Array(alert.recommended_actions.enumerated()), id: \.offset) { _, action in
                            Label(action, systemImage: "checklist").fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }.padding(.top, 12)
            }
        }
    }
}
