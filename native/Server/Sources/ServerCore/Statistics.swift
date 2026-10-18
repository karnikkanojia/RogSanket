import Foundation

// Standalone utilities preserve the Python research API; alert scans use baseline ratios.
enum Statistics {
    static func cusum(_ counts: [Double], mean: Double, std supplied: Double? = nil, k: Double = 1.5, h: Double = 5) -> Object {
        let std = supplied ?? max(sqrt(mean), 1)
        var values: [Double] = [], alarmIndex: Int?
        for (index, count) in counts.enumerated() {
            let next = max(0, (values.last ?? 0) + count - mean - k * std)
            values.append(next)
            if next > h * std, alarmIndex == nil { alarmIndex = index }
        }
        return ["alarm": .bool((values.last ?? 0) > h * std), "cusum_values": .array(values.map(JSON.number)),
                "alarm_index": alarmIndex.map(JSON.int) ?? .null, "current_cusum": .number(values.last ?? 0)]
    }
    static func poissonTail(_ observed: Int, expected: Double) -> Double {
        if observed <= 0 { return 1 }
        if expected <= 0 { return 0 }
        if Double(observed) > expected {
            var term = exp(-expected + Double(observed) * log(expected) - lgamma(Double(observed + 1)))
            var sum = term
            if term == 0 { return 0 }
            var k = observed
            while k < observed + 100_000 {
                k += 1; term *= expected / Double(k); sum += term
                if term <= sum * 1e-16 { break }
            }
            return min(1, max(0, sum))
        }
        let k = observed - 1
        var term = exp(-expected + Double(k) * log(expected) - lgamma(Double(k + 1)))
        var sum = term
        if k > 0 {
            for index in stride(from: k, through: 1, by: -1) {
                term *= Double(index) / expected; sum += term
                if term <= sum * 1e-16 { break }
            }
        }
        return min(1, max(0, 1 - sum))
    }
    static func poisson(_ observed: Int, expected: Double, alpha: Double = 0.01) -> Object {
        if expected <= 0 {
            return ["significant": .bool(observed > 0), "p_value": .number(observed > 0 ? 0 : 1),
                    "ratio": observed > 0 ? .string("Infinity") : 0, "excess": .int(observed), "critical_value": 1]
        }
        let probability = poissonTail(observed, expected: expected)
        var low = 0, high = max(1, Int(ceil(expected + 12 * sqrt(expected) + 12)))
        while poissonTail(high, expected: expected) > alpha { high *= 2 }
        while high - low > 1 {
            let middle = (low + high) / 2
            if poissonTail(middle, expected: expected) <= alpha { high = middle } else { low = middle }
        }
        return ["significant": .bool(probability < alpha), "p_value": .number(probability),
                "ratio": .number(roundEven(Double(observed) / expected, places: 2)), "excess": .number(Double(observed) - expected), "critical_value": .int(high)]
    }
    static func ears(_ counts: [Double], window: Int = 7, threshold: Double = 3) -> Object {
        if counts.count < window + 1 {
            return ["alarm": false, "z_scores": [], "message": .string("Need at least \(window + 1) data points")]
        }
        var zScores: [JSON] = [], periods: [JSON] = [], alarm = false
        for index in window..<counts.count {
            let baseline = Array(counts[(index - window)..<index])
            let mean = baseline.reduce(0, +) / Double(baseline.count)
            let std = max(sqrt(baseline.map { pow($0 - mean, 2) }.reduce(0, +) / Double(baseline.count - 1)), 1)
            let z = (counts[index] - mean) / std
            zScores.append(.number(z)); alarm = z > threshold
            if alarm { periods.append(.int(index)) }
        }
        return ["alarm": .bool(alarm), "z_scores": .array(zScores), "latest_z": zScores.last ?? 0, "alarm_periods": .array(periods)]
    }
}
