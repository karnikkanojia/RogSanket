import Foundation
import CryptoKit

struct Surveillance: Sendable {
    let thresholds: [String: Threshold]
    func weekly(_ records: [Object], syndrome: String, district: String, weeks: Int, now: Date) throws -> [(Date, Int)] {
        let cutoff = Time.calendar.date(byAdding: .day, value: -weeks * 7, to: now)!
        var counts: [Date: Int] = [:]
        for record in records where record["syndromic_signal"]?["syndrome_category"].text == syndrome && signalDistrict(record) == district {
            let timestamp = try Time.date(record.text("timestamp"))
            if timestamp >= cutoff { counts[Time.week(timestamp), default: 0] += 1 }
        }
        return counts.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }
    func scan(_ records: [Object], districts selected: [String]? = nil, now: Date = Date()) throws -> [Object] {
        let districts = selected ?? Array(Set(records.filter { $0["syndromic_signal"] != nil && $0["syndromic_signal"] != .null }.map { signalDistrict($0) })).sorted()
        var alerts: [Object] = []
        for district in districts {
            for syndrome in Signal.syndromes {
                let week = Time.week(now)
                let current = try records.filter {
                    guard $0["syndromic_signal"]?["syndrome_category"].text == syndrome,
                          signalDistrict($0) == district else { return false }
                    return try Time.date($0.text("timestamp")) >= week
                }.count
                if current == 0 { continue }
                let history = try weekly(records, syndrome: syndrome, district: district, weeks: 9, now: now).map { Double($0.1) }
                let baselineValues = history.count > 1 ? Array(history.dropLast()) : history
                let baseline = baselineValues.isEmpty ? 0 : baselineValues.reduce(0, +) / Double(baselineValues.count)
                let threshold = thresholds[syndrome] ?? Threshold(alert_threshold_multiplier: 2, minimum_cases_for_alert: 3)
                let ratio = Double(current) / max(baseline, 0.1)
                var level: String?
                if current >= threshold.minimum_cases_for_alert {
                    if ratio >= threshold.alert_threshold_multiplier * 2 { level = "emergency" }
                    else if ratio >= threshold.alert_threshold_multiplier { level = "warning" }
                    else if ratio >= threshold.alert_threshold_multiplier * 0.75 { level = "watch" }
                }
                if ["acute_hemorrhagic_fever", "acute_neurological_syndrome"].contains(syndrome) { level = level ?? "warning" }
                guard let level else { continue }
                let weekly = try weekly(records, syndrome: syndrome, district: district, weeks: 8, now: now).map { $0.1 }
                var trend = "insufficient_data", weeksAbove = 0
                if weekly.count >= 3 {
                    let last = Array(weekly.suffix(3))
                    trend = last[2] > last[1] && last[1] > last[0] ? "increasing" : (last[2] < last[1] ? "decreasing" : "stable")
                    weeksAbove = weekly.filter { Double($0) > baseline * threshold.alert_threshold_multiplier }.count
                }
                let calendar = Time.calendar
                let year = calendar.component(.yearForWeekOfYear, from: now), weekNumber = calendar.component(.weekOfYear, from: now)
                let id = uuid5("epicast:\(district):\(syndrome):(\(year), \(weekNumber))")
                alerts.append(["alert_id": .string(id), "alert_level": .string(level), "syndrome_category": .string(syndrome), "district": .string(district),
                    "case_count_current_week": .int(current), "case_count_baseline": .number(roundEven(baseline, places: 1)),
                    "ratio_to_baseline": .number(roundEven(ratio, places: 2)), "trend": .string(trend), "weeks_above_threshold": .int(weeksAbove),
                    "situation_summary": "", "recommended_actions": [], "evidence_summary": "", "forecast_next_week": .null,
                    "forecast_confidence_interval": .null, "timestamp": .string(Time.stamp(now))])
            }
        }
        return alerts
    }
    func summary(_ records: [Object], district: String, now: Date = Date()) throws -> (Object, [Object]) {
        let filtered = records.filter { $0["district"]?.text == district }
        let alerts = try scan(records, districts: [district], now: now)
        let evidence = alerts.map { alert -> JSON in
            ["syndrome": alert["syndrome_category"]!, "level": alert["alert_level"]!,
             "current_cases": alert["case_count_current_week"]!, "baseline": alert["case_count_baseline"]!,
             "ratio": alert["ratio_to_baseline"]!, "trend": alert["trend"]!]
        }
        return (["district": .string(district), "date": .string(Time.day(now)), "encounters": .int(filtered.count),
                 "counts": .object(distribution(filtered)), "alerts": .array(evidence)], alerts)
    }
    func distribution(_ records: [Object]) -> Object {
        var counts: [String: Int] = [:]
        for record in records { if let syndrome = record["syndromic_signal"]?["syndrome_category"].text { counts[syndrome, default: 0] += 1 } }
        return counts.mapValues(JSON.int)
    }
}
func roundEven(_ value: Double, places: Int) -> Double { Double(String(format: "%.*f", locale: Locale(identifier: "en_US_POSIX"), places, value))! }
func uuid5(_ name: String) -> String {
    // RFC 4122 URL namespace; preserve existing district/syndrome/week alert identities.
    let namespace: [UInt8] = [0x6b,0xa7,0xb8,0x11,0x9d,0xad,0x11,0xd1,0x80,0xb4,0x00,0xc0,0x4f,0xd4,0x30,0xc8]
    var bytes = Array(Insecure.SHA1.hash(data: Data(namespace) + Data(name.utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let values = Array(hex)
    return "\(String(values[0..<8]))-\(String(values[8..<12]))-\(String(values[12..<16]))-\(String(values[16..<20]))-\(String(values[20..<32]))"
}

func signalDistrict(_ record: Object) -> String {
    guard let district = record["district"]?.text, !district.isEmpty else { return "unknown" }
    return district
}
