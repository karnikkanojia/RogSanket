import SwiftUI
import Charts

struct OverviewView: View {
    @ObservedObject var workspace: Workspace
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(title: "Surveillance overview", subtitle: "Syndromic signals across your operating area.")
                if !workspace.dashboardError.isEmpty {
                    MessageBanner(message: "Unable to refresh. \(workspace.dashboardError)\(workspace.dashboard == nil ? "" : " Showing the last received data.")", error: true)
                }
                if let data = workspace.dashboard {
                    overview(data)
                } else if workspace.refreshing {
                    ProgressView("Loading surveillance data…").frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    EmptyState(title: "Surveillance data unavailable", detail: "Start the local API, then choose Refresh Data. Check the address in Connection Settings.", symbol: "network.slash")
                }
            }.padding(28).frame(maxWidth: 1200)
        }.navigationTitle("Overview")
    }

    @ViewBuilder private func overview(_ data: DashboardData) -> some View {
        HStack(alignment: .top, spacing: 0) {
            metric("Total encounters", value: data.total_encounters.formatted())
            Divider()
            metric("Active alerts", value: data.active_alerts.total.formatted())
            Divider()
            metric("Districts reporting", value: data.districts.count.formatted())
        }.fixedSize(horizontal: false, vertical: true).padding(.vertical, 8)
        Text("Updated \(displayDate(data.timestamp))").font(.caption).foregroundStyle(.secondary)
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 20) {
                distribution(data).frame(minWidth: 320)
                posture(data.active_alerts).frame(minWidth: 220, maxWidth: 290)
            }
            VStack(spacing: 20) { distribution(data); posture(data.active_alerts) }
        }
        Surface("Recent encounters", subtitle: "The latest 20 structured records received by surveillance") {
            if data.recent_encounters.isEmpty {
                EmptyState(title: "No encounters yet", detail: "Record an encounter to start the surveillance overview.", symbol: "tray")
                Button("Record encounter") { workspace.selection = .intake }.buttonStyle(.borderedProminent)
            } else {
                Table(Array(data.recent_encounters.reversed())) {
                    TableColumn("Syndrome") { item in Text(item.syndrome.map(readable) ?? "Unclassified signal") }
                    TableColumn("District") { item in Text(item.district ?? "District pending") }.width(min: 110, ideal: 150)
                    TableColumn("Recorded") { item in Text(displayDate(item.time)) }.width(min: 135, ideal: 180)
                }.frame(height: min(400, Double(data.recent_encounters.count) * 38 + 34))
            }
        }
    }
    private func metric(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.callout).foregroundStyle(.secondary)
            Text(value).font(.system(size: 32, weight: .semibold, design: .rounded)).monospacedDigit()
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
    }
    private func distribution(_ data: DashboardData) -> some View {
        Surface("Syndrome distribution", subtitle: "Signals from recorded encounters") {
            if data.syndrome_distribution.isEmpty {
                EmptyState(title: "No signals recorded", detail: "Syndromes appear after a successful extraction.", symbol: "chart.bar")
            } else {
                let values = data.syndrome_distribution.sorted { $0.key < $1.key }
                Chart(values, id: \.key) { item in
                    BarMark(x: .value("Encounters", item.value), y: .value("Syndrome", readable(item.key)), height: .fixed(14))
                        .foregroundStyle(Color.accentColor)
                        .annotation(position: .trailing) { Text(item.value.formatted()).font(.caption).monospacedDigit() }
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisValueLabel {
                            if let label = value.as(String.self) {
                                Text(label).font(.caption).lineLimit(2).frame(width: 145, alignment: .trailing)
                            }
                        }
                    }
                }
                .frame(height: max(100, Double(values.count) * 42))
                .accessibilityLabel("Syndrome distribution")
            }
        }
    }
    private func posture(_ counts: AlertCounts) -> some View {
        Surface("Alert posture", subtitle: "Current anomaly severity") {
            ForEach([("emergency", counts.emergency), ("warning", counts.warning), ("watch", counts.watch)], id: \.0) { level, count in
                HStack { SeverityBadge(level: level); Spacer(); Text(count.formatted()).font(.title3.weight(.semibold)).monospacedDigit() }
                if level != "watch" { Divider() }
            }
            Button("Review all alerts") { workspace.selection = .alerts }.padding(.top, 4)
        }
    }
}
