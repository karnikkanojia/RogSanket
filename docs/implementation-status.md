# Implementation status

## Verified on October 18, 2026

- Development hardware: Apple M1, 8 GB unified memory, native ARM64 Python 3.14.
- 26 model-free tests pass: SQLite durability/privacy, bounded queue, process
  cancellation, timeout/crash recovery, schema retry, aggregate-only remote
  reporting, local fallback, offline routing, report cache, stable alert IDs,
  artifact checksums, and explicit missing-model failures.
- Next.js TypeScript check and production build pass.
- Swift inference worker builds against pinned MLX Swift dependencies and returns
  the expected missing-artifact JSON protocol error.
- SwiftUI development client builds with media import, microphone dictation,
  camera capture, transcript review, intake, dashboard, alerts and report jobs.
- Real four-bit MedGemma 1.5 text inference runs through MLX on the M1 GPU.
  After correcting duplicated BOS tokenization, two synthetic extractions returned
  schema-valid JSON: 18.34 seconds cold, 7.09 seconds warm, approximately 23
  generated tokens/second and 2.63 GB peak MLX allocation. These are smoke
  measurements, not p95 or clinical validation. Earlier timing records used the
  duplicated-BOS path and remain historical evidence only.
- Original checkpoint access is enabled. All 58 offline processor comparisons
  pass against the pinned original HF assets: exact prompts, token IDs, masks,
  and image pixels through explicit PIL preprocessing. HF and MLX run in separate
  processes because MLX globally patches AutoProcessor.
- The vision smoke request exceeded available memory and was terminated by the
  active memory guard. Full multimodal M1 support is not certified.
- Apple runtime dependencies are locked. Swift worker dependencies are pinned
  and captured in `native/Worker/Package.resolved`.

## Remote deployment preparation

`docs/runpod.md` documents the candidate 80 GB GPU setup, authenticated API,
secret handling and sequential original-4B/27B verification.
`scripts/probe_remote.py` checks transport using synthetic aggregates; no paid
Pod has been started and no remote model has been verified.

The inherited synthetic evaluation labels contain contradictions. Row 25 labels
an alert patient with mild dehydration as critical and adds unsupported history.
Clinical label review is required before accuracy scores can gate promotion.

## Release gates still open

No verified MedGemma 1.5 artifact, MedASR reference fixtures, MedSigLIP reference
fixtures, or HeAR/classifier training contract was supplied in this checkout.
The cached original MedGemma 4B is a different base checkpoint and cannot certify
1.5. Runtime refuses to mark missing reference evidence as a pass.

The following remain unverified: exact model-output parity, including vision;
clinical extraction quality; ASR critical-term error; HeAR/classifier compatibility;
Core ML export/provider profiling; full offline network audit; 100-request
performance evaluation; 30-minute memory soak; 512-token report latency; native
worker model parity; live camera/microphone hardware behavior; native UI visual
review; Developer ID signing, notarization and packaged backend supervision.

Core ML promotion and transfer of surveillance/database ownership to Swift are
intentionally withheld until their prerequisite parity gates pass. Python remains
the only storage owner and the default model worker. No inference speedup,
clinical performance, or completed all-modality release is claimed.

## Compatibility changes

FastAPI on port 8000 is canonical. The old Flask launcher now starts it. The old
RunPod script is a transport adapter requiring `EPICAST_API_URL`, not a CUDA model
server. Legacy Flask `/v1/*`, RunPod `extract`/`fuse`, synthetic spectrogram output,
and implicit demo modality responses are removed. Existing Next.js endpoint
payloads remain compatible; report and encounter results gain provenance.
Configure optional 27B separately. Existing local LoRA adapters must be merged
against their original base on suitable hardware before conversion.

SQLite is a new durable schema. Back it up before any future schema migration.
Runtime artifacts and database files are ignored by Git. Original classifier
weights are retained but never unpickled or presented as validated inference.

## Latest local sweep

The 50-narrative experimental sweep stopped on its first request after 14.77
seconds: the active guard detected insufficient unified-memory headroom. No
extraction completed. This is a failed admission/runtime measurement, not a
quality result or sustained-load pass. Evidence is in
`docs/benchmarks/2026-10-18-m1-fixture-sweep.json`. The synthetic dataset reproduces
exactly from the inherited generator with seed 42; metadata records its defects.
