"""SQLite persistence. Raw clinical inputs never enter stored records."""
import json
import sqlite3
from pathlib import Path
from threading import RLock
from src.agents.surveillance_agent import SurveillanceDatabase
from src.data.syndromic_schema import ClinicalEncounter


class Store(SurveillanceDatabase):
    def __init__(self, path):
        super().__init__()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript('''
            CREATE TABLE IF NOT EXISTS encounters (
                id TEXT PRIMARY KEY, record TEXT NOT NULL, provenance TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                result TEXT, error TEXT, created TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, result TEXT NOT NULL);
        ''')
        self.connection.execute("UPDATE jobs SET status='failed', error='Service restarted' WHERE status IN ('queued','running')")
        self.connection.commit()
        for (record,) in self.connection.execute("SELECT record FROM encounters ORDER BY rowid"):
            super().add_encounter(ClinicalEncounter.model_validate_json(record))

    def add_encounter(self, encounter, provenance=None):
        record = encounter.model_copy(update={"narrative_text": "", "image_path": None, "location_lat": None, "location_lon": None})
        with self.lock, self.connection:
            self.connection.execute("INSERT INTO encounters VALUES (?, ?, ?)",
                                    (record.encounter_id, record.model_dump_json(), json.dumps(provenance or {})))
            super().add_encounter(record)

    def save_job(self, job):
        with self.lock, self.connection:
            self.connection.execute("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?, ?, ?)",
                (job["id"], job["kind"], job["status"], json.dumps(job.get("result")), job.get("error"), job["created"]))

    def get_job(self, job_id):
        with self.lock:
            row = self.connection.execute("SELECT id,kind,status,result,error,created FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        return dict(zip(("id", "kind", "status", "result", "error", "created"),
                        (*row[:3], json.loads(row[3]), *row[4:])))

    def cached_report(self, key):
        with self.lock:
            row = self.connection.execute("SELECT result FROM reports WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_report(self, key, result):
        with self.lock, self.connection:
            self.connection.execute("INSERT OR REPLACE INTO reports VALUES (?, ?)", (key, json.dumps(result)))

    def close(self):
        self.connection.close()
