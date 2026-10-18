# Apple Silicon runtime

## Status

The canonical API, process-isolated worker, durable storage, background jobs,
native modality inputs, and SwiftUI client are implemented. The MLX Python
and experimental Swift workers use pinned library interfaces. Model quality,
multimodal compatibility, sustained memory use, and throughput are **not yet
certified**. The release must not be described as complete until all gates pass.

The development machine is an M1 MacBook Pro with 8 GB unified memory. Local
27B is unsupported. Its four-bit weights alone need about 13.5 GB before runtime
overhead. Use optional remote 27B or local 4B report generation.

## Install and run

```bash
./setup_local.sh
EPICAST_ARTIFACT=/absolute/path/to/verified-4b .venv-apple/bin/python -m src.api.app
```

In another terminal:

```bash
bash native/App/bundle.sh
open native/App/dist/EpiCast.app
```

The setup uses native ARM64 Python 3.14, matching the development environment.
`requirements.txt` contains API dependencies. `requirements-apple.txt` adds model
libraries. `requirements-training.txt` belongs in a separate CUDA environment. Setup syncs
the complete `requirements-apple.lock`, resolved for macOS 14+ and Python 3.14.
No startup, inference request, or setup script downloads model weights.
Accept model terms and download a pinned snapshot explicitly before provisioning.
Use only local paths. The worker sets Hugging Face and Transformers offline flags.

Configuration:

| Variable | Purpose |
|---|---|
| `EPICAST_DATABASE` | SQLite file; default `data/epicast.sqlite3` |
| `EPICAST_ARTIFACT` | Verified four-bit multimodal MedGemma 1.5 4B directory |
| `EPICAST_MEDASR_ARTIFACT` | Verified MedASR CTC directory |
| `EPICAST_MEDSIGLIP_ARTIFACT` | Verified MedSigLIP directory |
| `EPICAST_HEAR_ARTIFACT` | Verified HeAR waveform ONNX export and classifier |
| `EPICAST_REMOTE_27B_URL` | Optional OpenAI-compatible chat-completions URL |
| `EPICAST_REMOTE_TOKEN` | Optional authorization token; never persisted |
| `EPICAST_ALLOWED_ORIGINS` | Comma-separated browser origins |
| `EPICAST_BACKEND` | `mlx` by default; `swift` only after native parity |
| `EPICAST_SWIFT_WORKER` | Absolute native worker executable when enabled |

Bind to localhost by default. LAN deployment requires authentication and TLS at
the deployment boundary. The RunPod handler is a transport adapter, configured
with `EPICAST_API_URL`. It no longer loads its own duplicate model stack.
The former Flask launcher starts the same FastAPI API on port 8000.

## Provisioning and reference evidence

Convert the exact accepted `google/medgemma-1.5-4b-it` snapshot using pinned
`mlx-vlm==0.7.8`. Perform conversion on larger hardware if peak memory exceeds
this Mac's budget. Check the installed converter's CLI with
`python -m mlx_vlm.convert --help`; do not convert an unrelated Gemma checkpoint.
Compare tokenizer output, chat template, image tokens, processor settings, text
extraction, and image outputs against the original checkpoint. Save reference
results and conversion details alongside the artifact. Existing LoRA weights
require the identical original base; merge on suitable hardware before conversion.

Each artifact contains `epicast-artifact.json`. This is an explicit release
attestation, not an automatically inferred certificate. Never set parity fields
without reference evidence. Hash all model, tokenizer, config, and processor
files. Runtime rejects missing checksums and mismatches before loading.

MedGemma manifest:

```json
{
  "base_model": "google/medgemma-1.5-4b-it",
  "revision": "EXACT_UPSTREAM_COMMIT",
  "quantization_bits": 4,
  "text_parity_passed": false,
  "image_parity_passed": false,
  "swift_parity_passed": false,
  "sha256": {"config.json": "SHA256", "model.safetensors": "SHA256"}
}
```

Auxiliary manifests specify `base_model`, exact `revision`, `sha256`, and
`reference_parity_passed`. MedASR and MedSigLIP default to CPU; enable MPS only
with `mps_parity_passed: true` after operator and output checks. MedSigLIP text
embeddings are precomputed once per encoder load. Encoders are unloaded between
tasks on 8 GB, trading reload latency for bounded residency.

HeAR additionally requires:

```json
{
  "base_model": "google/hear",
  "revision": "EXACT_EXPORT_REVISION",
  "reference_parity_passed": false,
  "input": "waveform_16khz_2s",
  "embedding_dimension": 512,
  "classifier_training_provenance": "PATH_OR_HASH_OF_TRAINING_RECORD",
  "labels": {"0": "healthy", "1": "symptomatic", "2": "COVID-19"},
  "sha256": {"hear.onnx": "SHA256", "classifier.onnx": "SHA256"}
}
```

The export must accept float32 `[1,32000]` waveforms at 16 kHz. The classifier
must consume the encoder's exact embedding and export labeled probability maps.
The example dimension is illustrative; use the verified classifier dimension.
The existing `classifier.pkl` has no verified training contract in this checkout.
It is deliberately never unpickled. The old padded/split mel windows and RMS
classifier are not retained. ONNX CPU is the reference path. Core ML promotion
requires a separately validated conversion and provider partition profile.

## Scheduling, privacy, and failure behavior

One active process task, eight pending tasks. Reports and multimodal workflows
also have bounded durable job states. Cancellation kills active model work;
the next request starts a clean worker. Worker crashes and deadlines do not kill
the API. Model startup is lazy. Statistical surveillance and dashboard remain
available without weights. Health reports artifact presence separately from
actual worker loading and never asserts release validation.

The Python worker starts with a 4096-token text budget, extraction output cap
512, report cap 1024, and prefill chunks of 256. One image is allowed, at most
16 megapixels. Clinical text is rejected rather than silently truncated.
No prompt cache persists between encounters. All heavy modalities execute in
the same serialized process lane. Loading an encoder first releases the LLM.

Health reports API RSS, available system memory, swap, pressure, queue state,
and last worker error. Unsupported system telemetry is `null`/`unknown`, never
fabricated. Generated responses include MLX allocation and token telemetry.
Do not infer total unified-memory use from API RSS. No wired-memory sysctl is
changed. Admission rejects critical pressure or less than 512 MiB available;
this is a safety floor, **not proof that a model fits**. The soak gate determines
whether the profile is supportable.

SQLite stores structured encounters, provenance, job states, and cached reports.
Narratives, images, and audio are not persisted by the API. Failed extraction
never creates an encounter. Multimodal extraction runs once and persists after
all requested modality tasks succeed. No automatic multimodal confidence fusion
is claimed. SQLite is not encrypted by this application; use OS disk encryption.

Remote reporting is disabled unless configured. It sends district-level counts,
alert evidence, and date, never encounter objects or raw media. A remote outage
falls back to 4B and labels the reason. Remote deployment remains operator-owned.
Reports are drafts, not validated forecasts. Counts and alert calculations remain
deterministic. Cache keys include surveillance summary, prompt version, model
manifest, and remote endpoint. Alert IDs remain stable within district/syndrome/week.

## Native migration

```bash
swift build --package-path native/App
swift run --package-path native/App EpiCast
swift build --package-path native/Worker -c release -j 2
```

The SwiftUI app provides all four surveillance workflows with native navigation, charts,
encounter tables, alert evidence, report export and connection settings. See
[native UI setup and parity](native-ui.md). It uses the canonical API for intake, transcript review,
media imports, microphone dictation, camera photos, dashboard, alerts, cancellable jobs, and reports. FastAPI remains
the only database writer. Start the API separately. This is a development
executable. Use `bash native/App/bundle.sh` to create an ad-hoc signed app bundle
with camera/microphone usage descriptions. Developer ID signing, notarization,
and packaged sidecar supervision remain distribution work. Capture requires the
app bundle and OS permission; hardware capture has not been exercised here.

The experimental worker uses `mlx-swift-lm==3.32.3` and the same newline JSON
request/response protocol. The scheduler can select it for generation while
retaining Python for auxiliary modalities; backend changes terminate the old
process before starting another. Enable `swift` only after artifact-specific
text, image, tokenizer, memory, and cancellation parity. The native manifest
requires `swift_parity_passed: true`; no automatic promotion occurs.

Do not port surveillance math or database ownership until Python/Swift fixture
parity passes. The browser client has been retired. Core ML auxiliary conversion and
removal of Python are subsequent gates, not current runtime claims.

## Verification and rollback

```bash
.venv/bin/python -m pytest tests -q
swift test --package-path native/App
.venv/bin/python scripts/evaluate_runtime.py --reference reference-results.json
.venv/bin/python scripts/benchmark_runtime.py --samples 100 --soak-seconds 1800
```

Run evaluations against a **separate** SQLite database: benchmarks submit real
structured test encounters. The frozen 50-example fixture covers all eight
syndromes. It reproduces exactly from the original template generator with seed
42. Its labels contain contradictions and unsupported history; use it only for
schema/runtime checks, never clinical accuracy gates. See
`data/evaluation_frozen.metadata.json`. Add independently reviewed negation, missing-detail,
cluster, severe-presentation, dictation, photo, and cough reference fixtures
before release. Evaluation failures score zero across all metrics.

Required gates: schema validity >=99%; syndrome accuracy, symptom F1 and
reportable recall within two percentage points of the same-checkpoint reference;
ASR critical-term and word error checks; image/HeAR/classifier reference parity;
100 measured requests after ten warm-ups; 30-minute soak with the release SwiftUI app open;
extraction p95 <=30 seconds; 512-token report p95 <=120 seconds; health p95 <=250 ms;
no OOM, sustained critical pressure, or sustained swap growth. The benchmark
writes raw samples, benchmarks ten uncached reports with a 512-token cap, and
fails when telemetry is unavailable. It does not certify modality, offline-network,
or Swift gates.

Run an offline network audit after provisioning, then repeat quality and soak
checks on every promoted artifact. Compare a same-checkpoint llama.cpp Metal
build separately; different models or quantization levels are not speed evidence.
No validated clinical quality or cross-backend speedup has been established.

For rollback, stop the service, back up SQLite using its backup API (including
WAL state), select the previous pinned artifact/worker, and restart. This is the
first durable schema; do not overwrite an existing database during upgrades.
Any future schema migration requires a backup and restoration test first.

### Experimental 4B provisioning

Provision the pinned public MLX candidate explicitly. This downloads approximately
3.44 GB and verifies published LFS checksums before writing an integrity manifest:

```sh
HF_HUB_DISABLE_XET=1 .venv/bin/python scripts/provision_mlx.py
.venv/bin/python scripts/probe_mlx.py \
  --artifact models/medgemma-1.5-4b-it-4bit \
  --allow-unvalidated-artifact --synthetic-image \
  --output inference-results.json
```

The probe uses synthetic text, runs offline, and records one cold and three warm
extractions, schema validity, timing, and memory. Add `--image /absolute/path`
for a nonclinical vision smoke test. A smoke test does not establish checkpoint
parity or clinical accuracy. Both parity flags remain false; FastAPI and the Swift
worker continue to reject this artifact for production use. The explicit probe
flag permits experimental execution while retaining checksum validation.

The candidate is `mlx-community/medgemma-1.5-4b-it-4bit` at
`762746b7a72b0b68dd8fa3f9aea5dc3980674d23`. Its model card reports conversion with
mlx-vlm 0.3.9; the installed runtime is 0.7.8. Original Google checkpoint metadata
access initially returned `GatedRepoError`. Access is now enabled and the
processor comparisons below pass. Model-output parity still requires independent
reference execution before promotion.

### First real M1 inference results

The pinned candidate passed upstream weight checksum verification. Four identical
synthetic encounter extractions produced schema-valid JSON with a 370-token prompt
and 118 generated tokens. End-to-end cold latency was 20.13 seconds; warm latencies
were 7.62, 7.12 and 7.34 seconds. Decode throughput was 21–23 tokens/second. Peak
MLX allocation was 2,659,010,836 bytes, excluding other applications and non-MLX
allocations. The raw synthetic-only record is in
`docs/benchmarks/2026-10-18-m1-smoke.json`.

Lazy loading leaves unused vision weights unevaluated for text requests; the
allocator cache is bounded to 128 MiB. Schema-constrained decoding uses the pinned
MLX-VLM llguidance implementation for extraction. Schema validity does not imply
clinical correctness. Report generation remains unconstrained and rejects
incomplete reasoning blocks rather than presenting them as final answers.

A library compatibility correction derives Gemma 3's image scaling dimension from
`text_config.hidden_size` (2560). MLX-VLM 0.7.8 otherwise defaults to 2048 for this
artifact. A synthetic tensor check showed image values incorrectly multiplied by
1.1171875 before correction and 1.0 afterward. Provenance lists the correction.
This arithmetic check does not replace image checkpoint/reference parity.

The first eager-load run reached critical system pressure and increased swap by
more than 2 GB. After closing applications, the lazy text run started with 2.79 GB
available and about 3.32 GB pre-existing swap. Swap grew about 210 MB on cold load,
then remained stable during three warm extractions. The subsequent image request
crossed the 512 MiB available-memory admission floor and was terminated. Neither
this short run nor its warm timings establish the sustained-workload release gate.
The scheduler now polls admission once per second during active execution and
kills the worker on failure. It also retains deadline and cancellation enforcement.

Production parity flags remain false. At the time of this first run, original
checkpoint metadata access was gated; the processor verification below resolves
that access issue. No clinical, full vision, 100-request, or
30-minute soak result is claimed, and these results do not promote the default.

A final text-only rerun recorded `Device(gpu, 0)` and worker RSS explicitly.
Cold extraction took 17.89 seconds and warm extraction 7.54 seconds, with both
outputs schema-valid. Peak MLX allocation was 2.71 GB. System swap decreased
across this short rerun; this is not a soak result. See
`docs/benchmarks/2026-10-18-m1-text.json`. RSS is reported separately from MLX
allocations and must not be added to them as independent memory pools.

### Original checkpoint processor verification

Original checkpoint access is enabled for the configured Hugging Face account.
Tokenizer and processor assets were downloaded at revision
`91850547d9f0b2fdd21aa7c5f4f3d1a8a52c243b`; no original model weights were downloaded.
Provision only the pinned processor assets, then run the offline comparison:

```sh
.venv/bin/hf download google/medgemma-1.5-4b-it \
  --revision 91850547d9f0b2fdd21aa7c5f4f3d1a8a52c243b \
  --local-dir models/medgemma-1.5-4b-reference \
  --include '*.json' '*.model' '*.jinja'
.venv/bin/python scripts/check_processor_parity.py \
  --reference models/medgemma-1.5-4b-reference \
  --candidate models/medgemma-1.5-4b-it-4bit
```

All 58 cases pass: 50 inherited synthetic narratives, three additional text
edge cases, a corrective chat turn, and four synthetic square/wide/tall/grayscale
images. Prompts, vocabulary mappings, input token IDs and masks are exact matches.
Image pixel tensors also match exactly using the explicit PIL backend. This
certifies the tested preprocessing path, not every image backend or clinical input.
The report records package versions and asset hashes at
`docs/benchmarks/2026-10-18-processor-parity.json`.

Reference and candidate processors run in separate processes. MLX globally patches
AutoProcessor; comparing both in one process could silently compare MLX to itself.
The tokenizer JSONs differ in raw image-token special flags, but effective vocabulary
mappings and special-token IDs match after loading their complete configurations.

The first comparison exposed duplicated BOS tokens on both text and image inputs.
MLX-VLM's special-token heuristic did not find the template on its processor object,
and its multimodal adapter dropped `add_special_tokens=False` for processors accepting
that flag through `**kwargs`. The worker now validates that the rendered Gemma template
owns BOS, disables extra special tokens, and calls the image processor directly to
preserve the explicit flag. Both fixes appear in generation provenance.

A corrected-tokenizer GPU rerun produced two schema-valid extractions in 18.34 seconds
cold and 7.09 seconds warm, at approximately 23 tokens/second. Peak MLX allocation
was 2.63 GB. The prompt contained 369 tokens rather than 370. Its syndrome label
changed from the earlier duplicated-BOS run; neither output establishes clinical
accuracy. Earlier records remain historical and do not certify the corrected path.
See `docs/benchmarks/2026-10-18-m1-bos-fixed.json`.

Processor verification does not set `text_parity_passed` or `image_parity_passed`.
Reference model-output and clinical quality comparisons, vision memory validation,
and the sustained workload gate remain required before production promotion.
