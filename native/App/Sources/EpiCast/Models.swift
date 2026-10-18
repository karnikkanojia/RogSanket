import Foundation

struct DashboardData: Decodable, Sendable {
    let timestamp: String
    let total_encounters: Int
    let syndrome_distribution: [String: Int]
    let districts: [String]
    let active_alerts: AlertCounts
    let recent_encounters: [RecentEncounter]
}
struct AlertCounts: Decodable, Sendable {
    let total: Int
    let emergency: Int
    let warning: Int
    let watch: Int
}
struct RecentEncounter: Decodable, Identifiable, Sendable {
    let id: String
    let time: String
    let district: String?
    let syndrome: String?
}
struct AlertsResponse: Decodable, Sendable {
    let alerts: [SurveillanceAlert]
}
struct SurveillanceAlert: Decodable, Identifiable, Sendable {
    var id: String { alert_id }
    let alert_id: String
    let alert_level: String
    let syndrome_category: String
    let district: String
    let case_count_current_week: Int
    let case_count_baseline: Double
    let ratio_to_baseline: Double
    let trend: String
    let weeks_above_threshold: Int
    let situation_summary: String
    let recommended_actions: [String]
    let evidence_summary: String
    let timestamp: String
}
struct Provenance: Decodable, Sendable {
    let model: String?
    let revision: String?
    let backend: String?
    let location: String?
}
struct SyndromicSignal: Decodable, Sendable {
    let symptoms: [String]
    let syndrome_category: String
    let severity: String
    let age_group: String
    let sex: String?
    let symptom_onset_days: Int?
    let icd10_codes: [String]
    let reportable_conditions_flagged: [String]
    let travel_history: String?
    let contact_history: String?
    let cluster_indicator: Bool
    let confidence_score: Double
}
struct EncounterResult: Decodable, Sendable {
    let encounter_id: String
    let timestamp: String
    let syndromic_signal: SyndromicSignal
    let total_encounters: Int
    let provenance: Provenance?
}
struct MultimodalResult: Decodable, Sendable {
    let encounter: EncounterResult
    let image: JSONValue?
    let cough: JSONValue?
}
struct SituationReport: Decodable, Sendable {
    let district: String
    let report_time: String
    let report: String
    let draft: Bool
    let provenance: Provenance
    let fallback_reason: String?
}
struct Transcription: Decodable, Sendable {
    let transcription: String
    let requires_review: Bool?
}
struct Job<Result: Decodable & Sendable>: Decodable, Sendable {
    let id: String
    let status: String
    let result: Result?
    let error: String?
    var isTerminal: Bool { ["succeeded", "failed", "cancelled"].contains(status) }
}
struct Health: Decodable, Sendable {
    let server_backend: String?
    let status: String
    let initialized: Bool
    let release_validated: Bool
    let artifacts_present: [String: Bool]
    let readiness_note: String
    let runtime: RuntimeHealth
}
struct RuntimeHealth: Decodable, Sendable {
    let queue_depth: Int
    let queue_capacity: Int
    let active: Bool
    let worker_loaded: Bool
    let last_error: String?
}
struct EncounterPayload: Encodable, Sendable {
    let narrative: String
    let district: String
    let facility_name: String
    var image_base64: String?
    var audio_base64: String?
}
struct ReportPayload: Encodable, Sendable {
    let district: String
    let max_tokens = 512
}
struct AudioPayload: Encodable, Sendable {
    let audio_base64: String
    let format: String
}

// Preserve supplementary modality results without inventing a stable schema.
indirect enum JSONValue: Codable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let x = try? value.decode(Bool.self) { self = .bool(x) }
        else if let x = try? value.decode(Double.self) { self = .number(x) }
        else if let x = try? value.decode(String.self) { self = .string(x) }
        else if let x = try? value.decode([String: JSONValue].self) { self = .object(x) }
        else { self = .array(try value.decode([JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let x): try value.encode(x)
        case .array(let x): try value.encode(x)
        case .string(let x): try value.encode(x)
        case .number(let x): try value.encode(x)
        case .bool(let x): try value.encode(x)
        case .null: try value.encodeNil()
        }
    }
    var formatted: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? ""
    }
}

func readable(_ value: String) -> String {
    value.replacingOccurrences(of: "_", with: " ").capitalized
}
func displayDate(_ value: String, time: Bool = true) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: value)
    if date == nil {
        formatter.formatOptions = [.withInternetDateTime]
        date = formatter.date(from: value)
    }
    // FastAPI's naive timestamps describe the local server's time zone.
    if date == nil {
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSS"
        date = local.date(from: value)
        if date == nil { local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"; date = local.date(from: value) }
    }
    guard let date else { return value }
    return date.formatted(date: .abbreviated, time: time ? .shortened : .omitted)
}
