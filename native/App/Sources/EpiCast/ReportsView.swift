import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ReportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

struct ReportsView: View {
    @ObservedObject var workspace: Workspace
    @State private var exporting = false
    @State private var exportError = ""
    private var document: ReportDocument {
        guard let report = workspace.report else { return ReportDocument(text: "") }
        return ReportDocument(text: "\(report.district) situation report · Draft\n\(displayDate(report.report_time))\nModel: \(report.provenance.model ?? "Unknown")\nExecution: \(report.provenance.location ?? "Unknown")\nRevision: \(report.provenance.revision ?? "Unrecorded")\n\(report.fallback_reason ?? "")\n\n\(report.report)\n\nGenerated recommendations require review.\n")
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(title: "Situation reports", subtitle: "Generate a draft from a district’s surveillance evidence.")
                Surface("Choose a district") {
                    HStack {
                        TextField("District name", text: $workspace.reportDistrict).textFieldStyle(.roundedBorder)
                            .onSubmit { if workspace.busy == nil { workspace.generateReport() } }
                        if let districts = workspace.dashboard?.districts, !districts.isEmpty {
                            Menu("Reporting districts") {
                                ForEach(districts, id: \.self) { district in
                                    Button(district) { workspace.reportDistrict = district }
                                }
                            }.fixedSize()
                        }
                        Button("Generate draft", action: workspace.generateReport)
                            .buttonStyle(.borderedProminent)
                            .disabled(!workspace.validReport || workspace.busy != nil)
                    }.disabled(workspace.busy == .reports)
                    OperationFeedback(workspace: workspace, destination: .reports)
                }
                if let report = workspace.report {
                    Surface("\(report.district) situation report · Draft", subtitle: displayDate(report.report_time)) {
                        ProvenanceView(provenance: report.provenance)
                        if let reason = report.fallback_reason { MessageBanner(message: reason) }
                        Divider()
                        Text(report.report).font(.body).lineSpacing(6).textSelection(.enabled)
                            .frame(maxWidth: 760, alignment: .leading)
                        Divider()
                        HStack {
                            Label("Review recommendations before use", systemImage: "pencil.and.outline")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("Copy") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(document.text, forType: .string)
                            }
                            Button("Save draft…") { exporting = true }
                        }
                    }
                } else if workspace.busy != .reports {
                    EmptyState(title: "No draft generated", detail: "Choose a district to create a report. Statistical alerts remain available if inference is unavailable.", symbol: "doc.text")
                }
                if !exportError.isEmpty { MessageBanner(message: exportError, error: true) }
            }.padding(28).frame(maxWidth: 1100)
        }
        .navigationTitle("Situation reports")
        .fileExporter(isPresented: $exporting, document: document, contentType: .plainText, defaultFilename: "EpiCast-draft-report.txt") { result in
            if case .failure(let error) = result { exportError = error.localizedDescription }
        }
    }
}
