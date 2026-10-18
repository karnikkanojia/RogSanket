import Foundation
import CSQLite
import Darwin

// SQLite FULLMUTEX and this lock protect the connection when jobs re-enter the service.
final class Store: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var db: OpaquePointer?
    private var lease: Int32 = -1
    init(path: String) throws {
        if path != ":memory:" {
            let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            lease = open(url.path + ".writer.lock", O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
            guard lease >= 0, flock(lease, LOCK_EX | LOCK_NB) == 0 else {
                if lease >= 0 { Darwin.close(lease); lease = -1 }
                throw ServerError.unavailable("Another server owns this database. Stop it before starting this server.")
            }
        }
        do {
            guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw ServerError.unavailable("Cannot open SQLite database") }
            sqlite3_busy_timeout(db, 5000)
            try execute("PRAGMA journal_mode=WAL")
            try execute("CREATE TABLE IF NOT EXISTS encounters (id TEXT PRIMARY KEY, record TEXT NOT NULL, provenance TEXT NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, created TEXT NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, result TEXT NOT NULL)")
            try execute("UPDATE jobs SET status='failed', error='Service restarted' WHERE status IN ('queued','running')")
        } catch { close(); throw error }
    }
    deinit { close() }
    func close() {
        lock.lock(); defer { lock.unlock() }
        if let db { sqlite3_close(db); self.db = nil }
        if lease >= 0 { flock(lease, LOCK_UN); Darwin.close(lease); lease = -1 }
    }
    private func prepare(_ sql: String, _ arguments: [String?]) throws -> OpaquePointer {
        guard let db else { throw ServerError.unavailable("Database closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw ServerError.unavailable("SQLite query failed")
        }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, text) in arguments.enumerated() {
            if let text { sqlite3_bind_text(statement, Int32(index + 1), text, -1, transient) }
            else { sqlite3_bind_null(statement, Int32(index + 1)) }
        }
        return statement
    }
    private func execute(_ sql: String, _ arguments: [String?] = []) throws {
        lock.lock(); defer { lock.unlock() }
        let statement = try prepare(sql, arguments)
        defer { sqlite3_finalize(statement) }
        let status = sqlite3_step(statement)
        guard status == SQLITE_DONE || status == SQLITE_ROW else { throw ServerError.unavailable("SQLite write failed; no record was saved") }
    }
    private func rows(_ sql: String, _ arguments: [String?] = []) throws -> [[String?]] {
        lock.lock(); defer { lock.unlock() }
        let statement = try prepare(sql, arguments)
        defer { sqlite3_finalize(statement) }
        var result: [[String?]] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW else { throw ServerError.unavailable("SQLite read failed") }
            result.append((0..<sqlite3_column_count(statement)).map { column in
                sqlite3_column_text(statement, column).map { String(cString: $0) }
            })
        }
    }
    func count() throws -> Int { Int(try rows("SELECT count(*) FROM encounters").first?[0] ?? "0") ?? 0 }
    func encounters() throws -> [Object] {
        try rows("SELECT record FROM encounters ORDER BY rowid").map { row in
            guard let text = row[0] else { throw ServerError.unavailable("Invalid stored record") }
            return try JSON.parse(Data(text.utf8)).object
        }
    }
    func add(_ source: Object, provenance: JSON) throws {
        var record = source
        record["narrative_text"] = ""; record["image_path"] = .null
        record["location_lat"] = .null; record["location_lon"] = .null
        try execute("INSERT INTO encounters VALUES (?, ?, ?)", [try record.text("encounter_id"), try JSON.object(record).serialized(), try provenance.serialized()])
    }
    func saveJob(_ job: Object) throws {
        try execute("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?, ?, ?)", [
            try job.text("id"), try job.text("kind"), try job.text("status"),
            try (job["result"] ?? .null).serialized(), job["error"]?.text, try job.text("created")])
    }
    func job(_ id: String) throws -> Object? {
        guard let row = try rows("SELECT id,kind,status,result,error,created FROM jobs WHERE id=?", [id]).first else { return nil }
        return ["id": .string(row[0]!), "kind": .string(row[1]!), "status": .string(row[2]!),
                "result": try JSON.parse(Data((row[3] ?? "null").utf8)),
                "error": row[4].map(JSON.string) ?? .null, "created": .string(row[5]!)]
    }
    func report(_ key: String) throws -> Object? {
        guard let text = try rows("SELECT result FROM reports WHERE key=?", [key]).first?[0] else { return nil }
        return try JSON.parse(Data(text.utf8)).object
    }
    func saveReport(_ key: String, _ report: Object) throws {
        try execute("INSERT OR REPLACE INTO reports VALUES (?, ?)", [key, try JSON.object(report).serialized()])
    }
}
