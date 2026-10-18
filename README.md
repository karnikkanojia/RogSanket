# 🦠 EpiCast — Agentic Disease Surveillance with MedGemma

**MedGemma Impact Challenge Submission**

> Turning frontline clinical encounters into real-time epidemiological intelligence using an agentic pipeline of HAI-DEF models — running entirely offline at the edge.

---

## Current implementation: Apple Silicon

SwiftUI is the application UI, backed by a Swift server, a process-isolated MLX worker
and SQLite. The retired Next.js client has been removed. See
[native UI setup](docs/native-ui.md). The development M1 has **8 GB unified
memory**. Local operation targets a verified four-bit 4B artifact; local 27B is
unsupported. Remote 27B is optional. The MLX Swift inference worker remains
experimental.

Start with [the Apple Silicon runtime guide](docs/apple-silicon.md). It documents
`uv` setup, artifact checksums and reference gates, offline operation, API jobs,
benchmarks, native builds, privacy, and remaining validation requirements.

**Status:** real 4B MLX text inference demonstrated on the M1: 7.1 seconds
for a warm synthetic extraction after correcting tokenization. All 58 original
HF/MLX processor comparisons pass. The image probe exceeded available memory.
Checkpoint parity, clinical quality and sustained performance are not yet certified. Missing modalities return errors. No synthetic transcription, image
classification, or cough result is presented as real inference. The HeAR classifier
in this checkout lacks verified training provenance and remains blocked.

The architecture and competition narrative below describe the original project
vision, not verified release capabilities. Diffusion forecasting, notarized distribution, and Core ML model promotion
remain future work. Native capture requires OS permissions and hardware testing.
This project originated from [the EpiCast Kaggle submission](https://www.kaggle.com/competitions/med-gemma-impact-challenge/writeups/new-writeup-1770830823676).

## The Problem

Disease outbreaks in low-resource settings are detected **weeks too late**. Community health workers (CHWs) see early signals — unusual symptom clusters, sudden spikes in presentations — but lack tools to aggregate, analyze, and escalate. Traditional surveillance relies on manual reporting chains: paper forms → district offices → national databases. By the time data reaches epidemiologists, outbreaks have already spread.

**WHO estimates that 60% of outbreaks in LMICs are detected by informal channels, not formal surveillance systems.** EpiCast bridges this gap.

## The Solution

EpiCast is an **agentic disease surveillance system** that transforms unstructured clinical encounters into structured epidemiological intelligence, running entirely on local hardware without internet connectivity.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        EpiCast Pipeline                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌───────────────────┐    ┌──────────────┐ │
│  │  MedASR       │───▶│  Intake Agent      │───▶│  Syndromic   │ │
│  │  (Speech→Text)│    │  (MedGemma 4B)     │    │  Database    │ │
│  └──────────────┘    │  Extracts:         │    └──────┬───────┘ │
│                       │  • Symptoms/Signs  │           │         │
│  ┌──────────────┐    │  • Demographics    │           │         │
│  │  MedSigLIP   │───▶│  • Severity        │           │         │
│  │  (Image Enc.) │    │  • Geo/Temporal    │           │         │
│  └──────────────┘    └───────────────────┘           │         │
│                                                        │         │
│  ┌────────────────────────────────────────────────────▼───────┐ │
│  │                Surveillance Analytics Agent                 │ │
│  │                    (MedGemma 27B)                           │ │
│  │  • Temporal aggregation of syndromic signals                │ │
│  │  • Anomaly detection (Poisson / CUSUM thresholds)           │ │
│  │  • Time-series forecasting (diffusion-based)                │ │
│  │  • Situation report generation                              │ │
│  │  • Outbreak probability scoring                             │ │
│  └────────────────────────────────────────────────────┬───────┘ │
│                                                        │         │
│  ┌────────────────────────────────────────────────────▼───────┐ │
│  │                 Escalation & Alert Agent                    │ │
│  │  • Auto-generates alerts for district health officers       │ │
│  │  • Patient-facing health advisories (multilingual)          │ │
│  │  • FHIR-compatible surveillance reports                     │ │
│  │  • Actionable recommendations with evidence                 │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### HAI-DEF Models Used

| Model | Role | Why |
|-------|------|-----|
| **MedGemma 1.5 4B** | Syndromic signal extraction from clinical narratives | Lightweight, runs offline, multimodal |
| **MedGemma 27B** | Epidemiological reasoning & situation reports | Deep clinical + EHR reasoning |
| **MedASR** | Clinical speech → text transcription | 82% fewer errors than Whisper on medical speech |
| **MedSigLIP** | Medical image encoding for disease pattern recognition | Zero-shot classification of reportable conditions |

### Novel Contributions

1. **Syndromic Surveillance as a Novel Task**: Using MedGemma not for individual diagnosis, but for population-level epidemiological signal extraction — a task it was never explicitly trained for
2. **Agentic Multi-Model Orchestration**: Four HAI-DEF models working as specialized agents in a coherent pipeline
3. **Diffusion-Based Outbreak Forecasting**: Integrating probabilistic time-series forecasting with MedGemma's clinical reasoning
4. **Edge-First Design**: Full intake pipeline runs on MedGemma 4B offline; syncs to 27B when connectivity is available

---

## Project Structure

```text
epicast/
├── native/
│   ├── App/                      # SwiftUI macOS application
│   ├── Server/                   # Swift application server and SQLite owner
│   └── Worker/                   # Experimental MLX Swift inference worker
├── src/
│   ├── runtime/                  # Inference workers and diagnostic scheduler
│   ├── agents/                   # Prompts, image triage and reference analytics
│   ├── models/                   # Model loaders and research utilities
│   ├── data/                     # Schemas, disease definitions and synthetic generator
│   └── utils/                    # Statistical anomaly detection
├── configs/                      # Model and surveillance configuration
├── scripts/                      # Provisioning, validation, benchmarks and training
├── tests/                        # Python inference and worker tests
├── data/                         # Local SQLite and synthetic regression fixtures
├── models/                       # Local model artifacts (weights ignored by Git)
└── docs/                         # Setup, validation evidence and remaining gates
```

## Native application

Build and start the Swift server, then open SwiftUI. No Node, Bun or browser is required.

```sh
bash native/Server/build.sh
./run_local.sh
```

In another terminal:

```sh
bash native/App/bundle.sh
open native/App/dist/EpiCast.app
```

The native app provides surveillance overview, active alerts, encounter intake
and district situation reports. See [the native UI guide](docs/native-ui.md)
for connection settings, model readiness, capture permissions and validation limits.

---

## Fine-Tuning Strategy

### What Gets Fine-Tuned (and Why)

**MedGemma 4B → LoRA fine-tune for Syndromic Extraction**

MedGemma is trained for clinical Q&A, radiology reporting, and medical knowledge. It is NOT trained
to extract structured epidemiological signals from free-text clinical narratives. We need it to:

- Parse "patient presents with 3 days of watery diarrhea, vomiting, and dehydration" into structured JSON:
  ```json
  {
    "symptoms": ["watery_diarrhea", "vomiting", "dehydration"],
    "syndrome_category": "acute_watery_diarrhea",
    "severity": "moderate",
    "onset_days": 3,
    "age_group": "adult",
    "icd10_codes": ["A09", "R11", "E86"],
    "reportable_conditions_flagged": ["cholera_suspect"]
  }
  ```

**Training Data**: The original generator can produce ~2,000 synthetic clinical encounter → structured extraction pairs. Its labels can contradict narratives and include unsupported history. Audit and repair the generator and labels before training or clinical evaluation. The intended categories are
covering WHO's priority syndromic surveillance categories:
- Acute watery diarrhea (cholera signal)
- Acute bloody diarrhea (dysentery)
- Acute febrile illness (malaria, dengue, typhoid)
- Acute respiratory infection (influenza, COVID, pneumonia)
- Acute neurological syndrome (meningitis, encephalitis)
- Acute rash with fever (measles, chickenpox)
- Acute hemorrhagic fever (Ebola, Marburg, dengue hemorrhagic)
- Unexplained cluster of illness

**LoRA Config**: r=16, alpha=32, targeting all linear layers, QLoRA 4-bit quantization
**Training**: ~1-2 hours on a single H100, using TRL's SFTTrainer

### What Stays Frozen

- **MedASR**: Works out-of-box for medical speech transcription (5.2% WER)
- **MedSigLIP**: Use as feature extractor with cosine similarity for zero-shot disease image matching
- **MedGemma 27B**: Prompt-engineered for surveillance reasoning — too large to fine-tune efficiently in 13 days, and prompting is sufficient for report generation

---

## Setup & Installation

```bash
./setup_local.sh
bash native/Server/build.sh
# After provisioning and reference validation:
EPICAST_ARTIFACT=/absolute/verified/model ./run_local.sh
```

Use [the runtime guide](docs/apple-silicon.md) for modality artifacts, the native
client, background jobs, and validation. See [the Swift server guide](docs/swift-server.md)
for worker isolation, SQLite compatibility and rollback. CUDA training uses a separate environment
with `requirements-training.txt`.

---

## Competition Deliverables

1. **Video Demo (≤3 min)**: Walkthrough of a simulated outbreak detection scenario
2. **Technical Overview (≤3 pages)**: Architecture, novel contributions, evaluation results
3. **Reproducible Code**: This repository + Kaggle notebook

## Target Awards
- **Main Track**: $30K (1st place)
- **Novel Task Prize**: $5K (syndromic surveillance as a new MedGemma application)

---

## License
CC BY 4.0 (as required by competition)
