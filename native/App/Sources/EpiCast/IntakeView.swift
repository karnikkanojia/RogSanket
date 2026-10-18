import SwiftUI
import UniformTypeIdentifiers

struct IntakeView: View {
    @ObservedObject var workspace: Workspace
    @StateObject private var audio = AudioCapture()
    @StateObject private var camera = PhotoCapture()
    @State private var importing = false
    @State private var importKind = "image"
    @State private var clearing = false
    private var locked: Bool { workspace.busy != nil || audio.recording || camera.running }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(title: "Record an encounter", subtitle: "Capture a narrative, review it, then submit it to local surveillance.")
                Surface("Clinical encounter", subtitle: "Required: district, facility and a narrative of at least 10 characters.") {
                    encounterFields
                    Divider()
                    captureControls
                    narrativeEditor
                    OperationFeedback(workspace: workspace, destination: .intake)
                    HStack {
                        Button("Submit encounter", action: workspace.submit)
                            .buttonStyle(.borderedProminent)
                            .disabled(!workspace.validEncounter || locked)
                        Button("Clear form") { clearing = true }
                            .disabled(locked || (workspace.narrative.isEmpty && workspace.image == nil && workspace.cough == nil))
                        Spacer()
                        if workspace.busy == nil { Text("Raw narrative is not stored by EpiCast.").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if let result = workspace.lastEncounter { EncounterReview(result: result) }
            }.padding(28).frame(maxWidth: 1100)
        }
        .navigationTitle("Record encounter")
        .fileImporter(isPresented: $importing, allowedContentTypes: importKind == "image" ? [.image] : [.audio]) { result in
            switch result {
            case .success(let url):
                if importKind == "dictation" { workspace.transcribe(url) }
                else { workspace.attach(url, image: importKind == "image") }
            case .failure(let error): workspace.importFailed(error)
            }
        }
        .sheet(isPresented: Binding(get: { workspace.pendingTranscript != nil }, set: { if !$0 { workspace.pendingTranscript = nil } })) {
            TranscriptReview(workspace: workspace)
        }
        .confirmationDialog("Clear the narrative and attached media?", isPresented: $clearing) {
            Button("Clear form", role: .destructive) {
                workspace.narrative = ""; workspace.removeImage(); workspace.removeCough()
            }
        } message: { Text("District and facility will be kept.") }
        .onDisappear { audio.discard(); camera.stop() }
    }

    private var encounterFields: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("District").font(.callout.weight(.medium))
                TextField("e.g. Central district", text: $workspace.district).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("District")
                if let districts = workspace.dashboard?.districts, !districts.isEmpty {
                    Menu("Choose a reporting district") {
                        ForEach(districts, id: \.self) { district in Button(district) { workspace.district = district } }
                    }.font(.caption)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Facility name").font(.callout.weight(.medium))
                TextField("e.g. Riverside clinic", text: $workspace.facility).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Facility name")
            }
        }.disabled(locked)
    }

    private var captureControls: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Dictation and optional media").font(.headline)
            Text("Audio, image and cough processing require provisioned, verified models. Artifact presence alone does not establish readiness.")
                .font(.callout).foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack { dictationButtons; Spacer(); attachmentButtons }
                VStack(alignment: .leading, spacing: 10) { HStack { dictationButtons }; HStack { attachmentButtons } }
            }
            if audio.recording {
                HStack {
                    Label(audio.purpose == .cough ? "Recording cough · Up to 2 seconds" : "Recording dictation · Up to 5 minutes", systemImage: "mic.fill")
                        .foregroundStyle(.red)
                    Spacer()
                    Button("Stop recording", action: audio.stop)
                }
            }
            if camera.running {
                CameraPreview(session: camera.session).frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 8))
                HStack {
                    Button("Take photo") { camera.capture { workspace.attach($0, image: true, captured: true) } }
                        .buttonStyle(.borderedProminent)
                    Button("Close camera", action: camera.stop)
                }
            }
            if !audio.error.isEmpty { MessageBanner(message: audio.error, error: true) }
            if !camera.error.isEmpty { MessageBanner(message: camera.error, error: true) }
            if let image = workspace.image {
                HStack(spacing: 12) {
                    if let preview = NSImage(contentsOf: image.url) {
                        Image(nsImage: preview).resizable().scaledToFit().frame(width: 72, height: 64)
                            .accessibilityLabel("Attached clinical image")
                    }
                    attachmentLabel(image, symbol: "photo")
                    Spacer()
                    Button("Remove image", action: workspace.removeImage).disabled(locked)
                }
            }
            if let cough = workspace.cough {
                HStack {
                    attachmentLabel(cough, symbol: "waveform")
                    Spacer()
                    Button("Remove cough", action: workspace.removeCough).disabled(locked)
                }
            }
        }
    }
    @ViewBuilder private var dictationButtons: some View {
        Button { record(.dictation) } label: { Label("Record dictation", systemImage: "mic") }
            .disabled(locked)
        Button("Import dictation…") { importKind = "dictation"; importing = true }.disabled(locked)
    }
    private var attachmentButtons: some View {
        Menu {
            Button("Import clinical image…") { importKind = "image"; importing = true }
            Button("Take photo…") { Task { await camera.start() } }
            Divider()
            Button("Import cough recording…") { importKind = "cough"; importing = true }
            Button("Record cough (2 seconds)") { record(.cough) }
        } label: { Label("Attach media", systemImage: "paperclip") }.fixedSize().disabled(locked)
    }
    private func record(_ purpose: AudioCapture.Purpose) {
        Task {
            await audio.start(purpose: purpose) { url in
                if purpose == .dictation { workspace.transcribe(url, temporary: true) }
                else { workspace.attach(url, image: false, captured: true) }
            }
        }
    }
    private func attachmentLabel(_ attachment: Attachment, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(attachment.name, systemImage: symbol).lineLimit(2)
            Text(attachment.size).font(.caption).foregroundStyle(.secondary)
        }
    }
    private var narrativeEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Clinical narrative").font(.callout.weight(.medium))
                Spacer()
                Text("\(workspace.narrative.count.formatted()) / 16,000 characters")
                    .font(.caption).monospacedDigit()
                    .foregroundStyle(workspace.narrative.count > 16000 ? Color.red : Color.secondary)
            }
            Text("Include symptoms, onset, relevant exposure history and examination findings. Review any transcription before submitting.")
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $workspace.narrative).font(.body)
                .scrollContentBackground(.hidden).padding(8).frame(minHeight: 190)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.primary.opacity(0.2)))
                .accessibilityLabel("Clinical narrative").disabled(locked)
            if workspace.narrative.count > 16000 {
                Text("The narrative exceeds 16,000 characters. Edit it before submitting; nothing will be discarded automatically.")
                    .font(.caption).foregroundStyle(.red)
            }
        }
    }
}

struct TranscriptReview: View {
    @ObservedObject var workspace: Workspace
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Review transcription").font(.title2.weight(.semibold))
            Text("Correct clinical terms and missing words before using this transcript.").foregroundStyle(.secondary)
            TextEditor(text: $text).font(.body).frame(minHeight: 240).accessibilityLabel("Transcript for review")
            HStack {
                Button("Discard", role: .cancel) { workspace.pendingTranscript = nil }
                Spacer()
                if !workspace.narrative.isEmpty {
                    Button("Append to narrative") {
                        workspace.narrative += "\n\n" + text
                        workspace.pendingTranscript = nil
                    }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button(workspace.narrative.isEmpty ? "Use transcript" : "Replace narrative") {
                    workspace.narrative = text; workspace.pendingTranscript = nil
                }.buttonStyle(.borderedProminent)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 650).onAppear { text = workspace.pendingTranscript ?? "" }
    }
}

struct EncounterReview: View {
    let result: MultimodalResult
    private var signal: SyndromicSignal { result.encounter.syndromic_signal }
    var body: some View {
        Surface("Encounter saved", subtitle: displayDate(result.encounter.timestamp)) {
            HStack { Text(readable(signal.syndrome_category)).font(.title3.weight(.semibold)); Spacer(); SeverityBadge(level: signal.severity) }
            LabeledContent("Symptoms", value: signal.symptoms.map(readable).joined(separator: ", "))
            LabeledContent("Age group", value: readable(signal.age_group))
            if let days = signal.symptom_onset_days { LabeledContent("Onset", value: "\(days) days") }
            LabeledContent("ICD-10 codes", value: signal.icd10_codes.joined(separator: ", "))
            if !signal.reportable_conditions_flagged.isEmpty {
                LabeledContent("Reportable flags", value: signal.reportable_conditions_flagged.map(readable).joined(separator: ", "))
            }
            if let travel = signal.travel_history { LabeledContent("Travel history", value: travel) }
            if let contact = signal.contact_history { LabeledContent("Contact history", value: contact) }
            LabeledContent("Cluster signal", value: signal.cluster_indicator ? "Reported" : "Not reported")
            Text("Extracted signals require review. Model confidence is not a calibrated disease probability.")
                .font(.caption).foregroundStyle(.secondary)
            if let provenance = result.encounter.provenance { ProvenanceView(provenance: provenance) }
            Text("Encounter \(result.encounter.encounter_id)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if let image = result.image { DisclosureGroup("Image analysis") { Text(image.formatted).font(.callout.monospaced()).textSelection(.enabled) } }
            if let cough = result.cough { DisclosureGroup("Cough analysis") { Text(cough.formatted).font(.callout.monospaced()).textSelection(.enabled) } }
        }
    }
}
