import Foundation
import Yams

struct Settings: Sendable {
    var root: URL
    var database: String
    var artifact: String
    var backend: String
    var python: String
    var swiftWorker: String?
    var remoteURL: URL?
    var remoteToken: String?
    var port: Int
    var timeout: Double = 180
    var queueCapacity = 8
    let remoteModel = "google/medgemma-27b-text-it"
    let environment: [String: String]
    init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        self.environment = environment
        root = URL(fileURLWithPath: environment["EPICAST_ROOT"] ?? FileManager.default.currentDirectoryPath).standardizedFileURL
        database = environment["EPICAST_DATABASE"] ?? root.appendingPathComponent("data/epicast.sqlite3").path
        artifact = environment["EPICAST_ARTIFACT"] ?? ""
        backend = environment["EPICAST_BACKEND"] ?? "mlx"
        guard ["mlx", "swift"].contains(backend) else { throw ServerError.invalid("EPICAST_BACKEND must be mlx or swift") }
        python = environment["EPICAST_PYTHON"] ?? root.appendingPathComponent(FileManager.default.fileExists(atPath: root.appendingPathComponent(".venv-apple/bin/python").path) ? ".venv-apple/bin/python" : ".venv/bin/python").path
        swiftWorker = environment["EPICAST_SWIFT_WORKER"]
        let url = environment["EPICAST_REMOTE_27B_URL"] ?? ""
        if !url.isEmpty {
            guard let value = URL(string: url), let host = value.host, value.user == nil, value.password == nil,
                  value.scheme == "https" || (value.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)) else {
                throw ServerError.invalid("Remote reporting requires HTTPS outside localhost and no embedded credentials")
            }
            remoteURL = value
        }
        remoteToken = environment["EPICAST_REMOTE_TOKEN"]
        guard let port = Int(environment["EPICAST_PORT"] ?? "8000"), (1...65535).contains(port) else { throw ServerError.invalid("Invalid EPICAST_PORT") }
        self.port = port
    }
    func artifactPresent(_ variable: String) -> Bool {
        guard let root = environment[variable], !root.isEmpty else { return false }
        return FileManager.default.fileExists(atPath: URL(fileURLWithPath: root).appendingPathComponent("epicast-artifact.json").path)
    }
    func thresholds() throws -> [String: Threshold] {
        struct Configuration: Decodable { let syndromic_categories: [String: Threshold] }
        let text = try String(contentsOf: root.appendingPathComponent("configs/surveillance_config.yaml"), encoding: .utf8)
        return try YAMLDecoder().decode(Configuration.self, from: text).syndromic_categories
    }
}
struct Threshold: Decodable, Sendable {
    var alert_threshold_multiplier: Double
    var minimum_cases_for_alert: Int
}

struct Signal {
    static let syndromes = ["acute_watery_diarrhea", "acute_bloody_diarrhea", "acute_febrile_illness", "acute_respiratory_infection", "acute_neurological_syndrome", "acute_rash_fever", "acute_hemorrhagic_fever", "unexplained_cluster"]
    static func validate(_ source: Object) throws -> Object {
        let strings = ["symptoms", "icd10_codes"]
        for field in strings {
            guard case .array(let values) = source[field], values.allSatisfy({ $0.text != nil }) else { throw ServerError.invalid("Invalid \(field)") }
        }
        guard let syndrome = source["syndrome_category"]?.text, syndromes.contains(syndrome),
              let severity = source["severity"]?.text, ["mild", "moderate", "severe", "critical"].contains(severity),
              let age = source["age_group"]?.text, ["neonate", "infant", "child", "school_age", "adolescent", "adult", "elderly"].contains(age),
              let confidence = source["confidence_score"]?.number, confidence.isFinite, (0...1).contains(confidence) else {
            throw ServerError.invalid("Invalid extracted signal schema")
        }
        var value = source
        for field in ["secondary_syndromes", "reportable_conditions_flagged"] {
            if value[field] == nil { value[field] = [] }
            guard case .array(let items) = value[field], items.allSatisfy({ $0.text != nil }) else { throw ServerError.invalid("Invalid \(field)") }
        }
        if value["cluster_indicator"] == nil { value["cluster_indicator"] = false }
        guard value["cluster_indicator"]?.flag != nil else { throw ServerError.invalid("Invalid cluster_indicator") }
        for field in ["sex", "travel_history", "contact_history"] {
            if value[field] == nil { value[field] = .null }
            guard value[field] == .null || value[field]?.text != nil else { throw ServerError.invalid("Invalid \(field)") }
        }
        for field in ["symptom_onset_days", "symptom_duration_days"] {
            if value[field] == nil { value[field] = .null }
            if value[field] != .null {
                guard let n = value[field]?.number, n.isFinite, n.rounded() == n else { throw ServerError.invalid("Invalid \(field)") }
            }
        }
        let fields = Set(strings + ["syndrome_category", "severity", "age_group", "confidence_score", "secondary_syndromes", "reportable_conditions_flagged", "cluster_indicator", "sex", "travel_history", "contact_history", "symptom_onset_days", "symptom_duration_days"])
        return value.filter { fields.contains($0.key) }
    }
}
