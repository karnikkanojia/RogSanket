import Foundation

extension Service {
    func fhir(_ district: String, now: Date = Date()) throws -> Object {
        let records = try store.encounters()
        let start = Time.calendar.date(byAdding: .day, value: -7, to: now)!
        let filtered = try records.filter {
            guard $0["district"]?.text == district else { return false }
            let time = try Time.date($0.text("timestamp"))
            return time >= start && time <= now
        }
        let counts = surveillance.distribution(filtered)
        let alerts = try surveillance.scan(records, districts: [district], now: now)
        let total = counts.values.compactMap(\.number).reduce(0, +)
        // Python Counter/max keeps the first encountered syndrome when counts tie.
        let order = filtered.compactMap { $0["syndromic_signal"]?["syndrome_category"].text }
        var top = "none", topCount = -1.0
        for syndrome in order {
            if let count = counts[syndrome]?.number, count > topCount { top = syndrome; topCount = count }
        }
        var narrative = "Syndromic surveillance report for \(district). Total encounters: \(Int(total)). Most common syndrome: \(top.replacingOccurrences(of: "_", with: " ")) (\(Int(counts[top]?.number ?? 0)) cases). "
        let emergency = alerts.filter { $0["alert_level"]?.text == "emergency" }.count
        let warning = alerts.filter { $0["alert_level"]?.text == "warning" }.count
        if emergency > 0 { narrative += "EMERGENCY alerts active for \(emergency) syndrome(s). " }
        else if warning > 0 { narrative += "WARNING alerts for \(warning) syndrome(s). " }
        var entries: [JSON] = [["resource": ["resourceType": "Composition", "id": .string(UUID().uuidString.lowercased()), "status": "final",
            "type": ["coding": [["system": "http://loinc.org", "code": "55751-2", "display": "Public health Case report"]]],
            "date": .string(Time.stamp(now)), "title": .string("Syndromic Surveillance Report - " + district), "author": [["display": "District Surveillance System"]],
            "section": [["title": "Surveillance Period", "text": ["status": "generated", "div": .string("<div>Period: \(Time.day(start)) to \(Time.day(now))</div>")]],
                        ["title": "Syndromic Summary", "text": ["status": "generated", "div": .string("<div>\(xmlEscape(narrative))</div>")]]]]]]
        for syndrome in counts.keys.sorted() {
            entries.append(["resource": ["resourceType": "Observation", "id": .string(UUID().uuidString.lowercased()), "status": "final",
                "code": ["coding": [["system": "http://epicast.surveillance/syndromes", "code": .string(syndrome), "display": .string(syndrome.replacingOccurrences(of: "_", with: " ").capitalized)]]],
                "valueQuantity": ["value": counts[syndrome]!, "unit": "cases"], "effectivePeriod": ["start": .string(Time.stamp(start)), "end": .string(Time.stamp(now))]]])
        }
        for alert in alerts {
            entries.append(["resource": ["resourceType": "DetectedIssue", "id": alert["alert_id"]!, "status": "final",
                "code": ["coding": [["system": "http://epicast.surveillance/alerts", "code": alert["alert_level"]!, "display": .string(alert["alert_level"]!.text!.uppercased() + " - " + alert["syndrome_category"]!.text!)]]],
                "detail": .string("\(alert["syndrome_category"]!.text!) elevated in \(district)"), "identifiedDateTime": alert["timestamp"]!]])
        }
        return ["resourceType": "Bundle", "id": .string(UUID().uuidString.lowercased()), "type": "collection", "timestamp": .string(Time.stamp(now)), "meta": ["profile": ["http://hl7.org/fhir/StructureDefinition/Bundle"]], "entry": .array(entries)]
    }
}
func xmlEscape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}
