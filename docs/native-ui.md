# Native macOS interface

SwiftUI is the supported UI. The four former Next.js routes have native
counterparts, and the browser client has been removed. No Node or browser is needed.
The Swift application server and isolated model worker run as separate processes.
The server owns SQLite; the worker owns model execution.
The API contracts remain available to native clients and tools.

## Build and launch

Requires macOS 14 or later and the Xcode Swift toolchain.

```sh
# In the repository root, after the Python environment is provisioned:
bash native/Server/build.sh
./run_local.sh
```

In another terminal:

```sh
bash native/App/bundle.sh
open native/App/dist/EpiCast.app
```

The bundle is ad-hoc signed for local development. It is not Developer ID signed
or notarized. Camera and microphone usage descriptions are included. macOS asks
for capture permission on first use; imported files remain available as an
alternative. Start EpiCast Server separately. No model downloads or server launches
occur when opening the app.

The default API address is `http://127.0.0.1:8000`. Connection Settings supports
other localhost ports. Remote hosts, embedded credentials and URL query strings
are rejected. Only the address is persisted in UserDefaults. Narratives,
transcripts, reports and media are not saved as UI preferences. API responses
use an ephemeral URLSession without a disk cache.

## Workflow parity

| Former browser route | Native view | Behavior |
| --- | --- | --- |
| `/` | Overview | Encounter count, district count, alert totals, syndrome chart, severity posture, last-update time, recent-encounter table and refresh |
| `/alerts` | Active alerts | Actual API syndrome/district/count fields, severity badges, timestamps, evidence and baseline disclosure; adds search and severity filtering |
| `/intake` | Record encounter | Required district/facility/narrative, dictation import, transcript review, optional clinical image and cough attachment, submission, result and errors |
| `/reports` | Situation reports | District selection, background report jobs, cancellation, draft text, timestamp, model provenance and fallback reason; adds copy/save |
| Shared shell | NavigationSplitView | Sidebar selection, toolbar refresh, connection status, connection/model-availability settings |

Native capture adds camera photos, microphone dictation and bounded two-second
cough recording. Dictation stops automatically after five minutes. Transcript
review offers explicit append/replace actions; transcription does not silently
overwrite the narrative. Selected media is read through a security-scoped URL,
bounded to 10 MB, copied into a private temporary directory, and removed on
replacement, successful submission or normal app termination. Images must be single-frame and no larger than 16 megapixels; metadata is checked
before preview decoding. The source file is never deleted. After a crash, temporary files may remain until OS cleanup.

Inputs are kept after failed submissions. A successful submission clears the
narrative and attachments and shows the extracted signal, codes, reportable
flags and provenance. Oversized narratives are rejected without truncation.
Supplementary modality results remain available in disclosure sections.

All encounters use the cancellable multimodal job route, including text-only
encounters; the service extracts once. A cancellation during initial submission
waits for the server job ID before sending DELETE. If the response itself is lost,
the UI warns that the server may have accepted the request: check records before
retrying. There is no idempotency-key contract in the existing API.

Overview, health and alert refreshes remain available during inference. Closing
or changing a view does not resubmit or cancel a job. The app does not promise
server-side cancellation for `/transcribe`, whose API has no job cancellation
contract. Closing the app does not stop EpiCast Server; an accepted server job may
continue. Do not close the app to cancel inference; use Cancel and wait for
confirmation instead.

Keyboard shortcuts: Command-1 through Command-4 select the four views,
Command-N opens intake, Command-R refreshes data, and Command-comma opens settings.
The UI uses native controls, SF Symbols, semantic system colors and system light/
dark appearance. Charts include accessible labels; severity also has text and
symbols. The window supports sidebar collapse and scrollable content.

## Verification and limits

```sh
swift test --package-path native/App
.venv/bin/python -m pytest tests -q
```

Twelve native tests cover captured FastAPI contracts, local-address checks, failed
and malformed responses, report jobs/provenance, actual cancellation requests,
cancellation before initial acknowledgment, successful-input clearing and refresh, failed-input retention, nontruncating
validation, bounded media import and temporary-file removal. The health,
dashboard and alert fixtures were captured from the real FastAPI app using a
separate test database. The encounter job fixture exercises the real route and
storage with only extraction stubbed. The report fixture is explicitly synthetic contract data,
never a runtime fallback.

On October 18, 2026, debug and release builds passed; the local bundle's ad-hoc
signature verified. Native UI inspection used an isolated API with 24 synthetic
records in a `TEST` district. Overview, alert evidence, navigation, settings and
report/intake unavailable-model states were exercised. No test records were
written to the application's normal database.

The UI port does not certify model correctness or memory use. Real generation is
still subject to artifact parity gates. ASR, images and cough remain unavailable
until their artifacts pass validation. Live microphone/camera capture, calibrated
clinical quality, notarization and automated backend supervision remain separate
validation/distribution work.

The application server is Swift. The Python HTTP server has been removed after
API parity checks; Python inference workers remain. See [Swift server migration](swift-server.md).
