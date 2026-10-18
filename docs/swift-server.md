# Swift application server

EpiCast Server replaces FastAPI for the application's API, storage and orchestration.
It runs on macOS 14+ using pinned Vapor 4.122.2 and Yams 6.0.2 dependencies, with
all transitive revisions captured in `native/Server/Package.resolved`. SwiftUI
keeps the same localhost API contract. No 27B deployment is required.

```text
SwiftUI
  |
Swift application server
  |-- SQLite: structured encounters, jobs, report cache and provenance
  |-- Surveillance: weekly baselines, thresholds, alerts and FHIR
  |-- Jobs: admission, status, events, cancellation and restart recovery
  |
Inference interface
  |-- Local JSONL Python worker (default; MLX and auxiliary models)
  |-- Validated MLX Swift worker (experimental, generation only)
```

The inference protocol is separate from application logic. A future HTTP model
service can implement that interface without changing surveillance or SwiftUI.
MLX-VLM still transitively installs FastAPI and Uvicorn; EpiCast no longer imports
or starts either package. They are not direct application dependencies.

No such remote modality service is enabled by this migration. Remote 27B reporting
remains an optional aggregate-only path.

## Build and run

From the repository root:

```sh
./setup_local.sh
bash native/Server/build.sh
EPICAST_ARTIFACT=/absolute/path/to/verified-4b ./run_local.sh
```

Then open `native/App/dist/EpiCast.app`, or rebuild it with
`bash native/App/bundle.sh`. The UI connects to `http://127.0.0.1:8000` by default.
Model execution remains unavailable if its existing artifact gates have not
passed. Server startup and read-only surveillance do not load models or download
weights. Missing model configuration produces an explicit error on inference.

The first server build compiles HTTP dependencies and can take several minutes.
Build concurrency defaults to two jobs. `EPICAST_SERVER_BUILD_DIR` changes the
Swift build cache. The build script copies the executable and resource bundles
to `native/Server/dist/` and ad-hoc signs the executable. This is a local build,
not a notarized distribution or a self-contained model installation.

| Variable | Purpose |
| --- | --- |
| `EPICAST_ROOT` | Repository/configuration directory; set by `run_local.sh` |
| `EPICAST_SERVER_BIN` | Optional native server executable used by the launcher |
| `EPICAST_PORT` | HTTP port; defaults to 8000, bound to 127.0.0.1 |
| `EPICAST_DATABASE` | Existing compatible SQLite file; defaults to `data/epicast.sqlite3` |
| `EPICAST_PYTHON` | Python executable for inference; detects `.venv-apple`, then `.venv` |
| `EPICAST_ARTIFACT` | Validated local four-bit artifact directory |
| `EPICAST_BACKEND` | `mlx` by default; experimental `swift` requires model parity |
| `EPICAST_SWIFT_WORKER` | Validated native worker binary for generation |
| `EPICAST_REMOTE_27B_URL` | Optional HTTPS chat-completions endpoint; HTTP allowed only on loopback |
| `EPICAST_REMOTE_TOKEN` | Optional remote authorization token |

Auxiliary artifact environment variables retain their existing meanings in
`docs/apple-silicon.md`. Surveillance thresholds are read from the existing
`configs/surveillance_config.yaml`. The extraction and report prompts are frozen
in the native resource bundle; Python tests check that they match the reference
prompts, so prompt changes require updating both implementations deliberately.

## API and behavior

The server implements health, dashboard, alerts, district scans, encounter intake,
background reports and multimodal jobs, job inspection/cancellation/SSE,
transcription, both image-route aliases, cough analysis, advisories and FHIR reports.
The removed synthetic spectrogram endpoint continues to return 410.

Responses preserve the application payloads and `detail` error envelope. Queue
overflow returns 429 with Retry-After; memory pressure returns 503; inference
deadlines return 504. Health adds optional `server_backend: "swift"` and preserves
model readiness and memory information. FastAPI's generated Swagger/OpenAPI pages
are not part of the native server; this guide describes the retained routes.

Validation rejects invalid media before creating a job, rather than accepting a
job that will fail later. Inputs are bounded to 16,000 narrative code points,
200-character district/facility names, 16 MB base64 fields and a 32 MiB HTTP body.
Extraction validates the syndrome, severity, demographics, symptom lists and
confidence range, with one corrective retry. Multimodal submission extracts once
and commits the encounter only after all requested modalities succeed.

The queue allows eight pending inference requests and one active task. A worker
is reused across requests. Deadlines, cancellation, pressure and crashes stop or
restart it; changing to the experimental native worker releases the previous
process first. Native memory telemetry controls admission and monitors pressure
while a model executes. The server is free to handle health/dashboard requests
while awaiting inference. The worker's own model checks and memory guard remain.

Parent-process supervision terminates workers if the native server dies during
an inference request. Normal shutdown cancels jobs and closes the worker protocol,
with a bounded wait before forced termination. An unexpected restart marks queued
and running jobs failed rather than repeating extraction automatically.

Reports contain district counts and alert evidence only. Remote requests reject
redirects; remote failure falls back to local 4B with a label. Report cache keys
include the surveillance snapshot, local manifest identity, remote endpoint,
output budget and prompt version. Native cache keys have a separate format marker;
existing Python cache rows remain intact, but the first native request can miss
an older cached report. Generated recommendations remain drafts.

## SQLite ownership and rollback

The table schema is unchanged. There is no data conversion or table deletion.
The Swift server acquires an exclusive `<database>.writer.lock` lease before
opening SQLite or recovering jobs. Stop the active server before switching builds. Do
not remove the lock file to bypass ownership: an abandoned lock is released by
the OS, and deleting a live lock file could allow two owners.

Before first production cutover, stop the service and back up the database using
SQLite's backup API, which includes committed WAL contents:

```sh
.venv-apple/bin/python - <<'PY'
import sqlite3
from pathlib import Path
backup = Path('data/epicast.pre-swift.sqlite3')
if not Path('data/epicast.sqlite3').is_file():
    raise SystemExit('Source database does not exist; check EPICAST_DATABASE')
if backup.exists():
    raise SystemExit('Backup already exists; choose a new destination')
with sqlite3.connect('data/epicast.sqlite3') as source:
    with sqlite3.connect(backup) as destination:
        source.backup(destination)
PY
```

Start the Swift server with `./run_local.sh`. The Python HTTP server, application
service, job manager and SQLite store have been removed. Python inference workers,
evaluation tools and reference analytics remain. `epicast_local_server.py` remains
a compatibility launcher for Swift.

For rollback, stop the service and restore a previously pinned native build and
its compatible database backup. The former Python server exists in Git commit
`56751dc`; use a separate checkout and its own dependencies if historical recovery
is necessary. Never start it against a database already owned by another server.

No production database was modified by migration tests. Before removal, Python
successfully read native encounters and jobs using the unchanged schema. Native
storage excludes raw narratives, coordinates and image paths from persisted
encounters. SQLite remains unencrypted by the application.

## Verification

```sh
.venv/bin/python scripts/export_server_fixtures.py
swift test --package-path native/Server
swift test --package-path native/App
.venv/bin/python -m pytest tests -q
.venv/bin/python scripts/verify_swift_server.py \
  --server-bin native/Server/dist/EpiCastServer
```

The exporter freezes four synthetic all-syndrome surveillance cases and six
statistical cases from Python, including sparse history, ISO-year boundaries,
Monday transitions, CUSUM, Poisson and EARS. Native tests compare those outputs,
including stable alert IDs, with numeric tolerances for floating-point statistics.
All 18 native server tests pass in release configuration. Additional cases preserve
empty-district handling, FHIR tie behavior and committed success during cancellation.
These are software regression fixtures, not clinical validation.

The packaged release passed 38 HTTP checks on October 18, 2026. Evidence,
including the executable SHA256 and observed health latency, is recorded in
`docs/benchmarks/2026-10-18-swift-server.json`.

The HTTP verifier uses isolated temporary databases and explicitly injected
synthetic model workers. It checks seeded dashboard counts, alerts, scans and FHIR
structure, media routes, job status/SSE, cancellation/recovery, privacy, remote
aggregate routing and fallback, missing-artifact errors from the real Python
worker, and SQLite durability after exit. Native unit tests preserve the frozen
Python surveillance/statistics parity fixtures. The original 38-check migration
record above includes live FastAPI comparisons performed before its removal.
Post-removal verification passed 18 native tests, 17 Python worker tests and 38
HTTP checks; see `docs/benchmarks/2026-10-18-python-server-removal.json`. One
native test run stalled; its rerun passed. The stall cause remains unconfirmed.
The verifier never opens the application's normal database. Successful synthetic
inference is not evidence that a clinical model is provisioned or validated.

Model parity, clinical quality, the 100-request workload and 30-minute soak remain
separate release gates. The server port does not establish faster model decoding,
validated auxiliary modalities, remote 27B quality or notarized packaging.

References: [Vapor async APIs](https://docs.vapor.codes/async/) and
[Vapor server lifecycle](https://api.vapor.codes/vapor/application/).
