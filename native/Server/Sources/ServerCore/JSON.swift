import Foundation

typealias Object = [String: JSON]
indirect enum JSON: Codable, Sendable, Equatable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    case object(Object), array([JSON]), string(String), number(Double), bool(Bool), null
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
    init(nilLiteral: ()) { self = .null }
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let x = try? value.decode(Bool.self) { self = .bool(x) }
        else if let x = try? value.decode(Double.self) { self = .number(x) }
        else if let x = try? value.decode(String.self) { self = .string(x) }
        else if let x = try? value.decode(Object.self) { self = .object(x) }
        else { self = .array(try value.decode([JSON].self)) }
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
    var object: Object { if case .object(let value) = self { value } else { [:] } }
    var array: [JSON] { if case .array(let value) = self { value } else { [] } }
    var text: String? { if case .string(let value) = self { value } else { nil } }
    var number: Double? { if case .number(let value) = self { value } else { nil } }
    var flag: Bool? { if case .bool(let value) = self { value } else { nil } }
    subscript(_ key: String) -> JSON { object[key] ?? .null }
    static func int(_ value: Int) -> JSON { .number(Double(value)) }
    func data(sorted: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = sorted ? [.sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
        return try encoder.encode(self)
    }
    func serialized(sorted: Bool = false) throws -> String { String(decoding: try data(sorted: sorted), as: UTF8.self) }
    static func parse(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
}

struct ServerError: Error, LocalizedError, Sendable {
    let status: Int
    let message: String
    var retryAfter: Int? = nil
    var errorDescription: String? { message }
    static func invalid(_ message: String) -> ServerError { ServerError(status: 422, message: message) }
    static func unavailable(_ message: String) -> ServerError { ServerError(status: 503, message: message) }
    static var cancelled: ServerError { ServerError(status: 499, message: "Cancelled") }
}

extension Dictionary where Key == String, Value == JSON {
    func text(_ key: String, default fallback: String? = nil, maximum: Int = Int.max, minimum: Int = 0) throws -> String {
        guard let result = self[key]?.text ?? fallback, result.unicodeScalars.count >= minimum,
              result.unicodeScalars.count <= maximum else { throw ServerError.invalid("Invalid \(key)") }
        return result
    }
    func integer(_ key: String, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
        guard let value = self[key] else { return fallback }
        guard let number = value.number, number.isFinite, number.rounded() == number,
              number >= Double(range.lowerBound), number <= Double(range.upperBound) else {
            throw ServerError.invalid("Invalid \(key)")
        }
        return Int(number)
    }
}

enum Time {
    static func stamp(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSS"
        let value = formatter.string(from: date)
        return value.hasSuffix(".000000") ? String(value.dropLast(7)) : value
    }
    static func date(_ text: String) throws -> Date {
        for format in ["yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXXXX", "yyyy-MM-dd'T'HH:mm:ssXXXXX", "yyyy-MM-dd'T'HH:mm:ss.SSSSSS", "yyyy-MM-dd'T'HH:mm:ss"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = format
            if let result = formatter.date(from: text) { return result }
        }
        throw ServerError.invalid("Invalid encounter timestamp")
    }
    static func day(_ date: Date) -> String { String(stamp(date).prefix(10)) }
    static var calendar: Calendar { var c = Calendar(identifier: .iso8601); c.timeZone = .current; return c }
    static func week(_ date: Date) -> Date { calendar.dateInterval(of: .weekOfYear, for: date)!.start }
}
