# 🦠 EpiCast — Agentic Disease Surveillance with MedGemma

**MedGemma Impact Challenge Submission**

> Turning frontline clinical encounters into real-time epidemiological intelligence using an agentic pipeline of HAI-DEF models — running entirely offline at the edge.

---

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

```
epicast/
├── README.md
├── requirements.txt
├── configs/
│   ├── model_config.yaml          # Model paths, LoRA config, inference params
│   └── surveillance_config.yaml    # Disease definitions, alert thresholds
├── src/
│   ├── agents/
│   │   ├── __init__.py
│   │   ├── intake_agent.py         # MedASR + MedGemma 4B syndromic extraction
│   │   ├── image_triage_agent.py   # MedSigLIP + MedGemma 4B image analysis
│   │   ├── surveillance_agent.py   # MedGemma 27B analytics + forecasting
│   │   └── alert_agent.py          # Escalation, FHIR reports, advisories
│   ├── models/
│   │   ├── __init__.py
│   │   ├── medgemma_loader.py      # Model loading utilities (4B, 27B, quantized)
│   │   ├── medasr_loader.py        # MedASR speech-to-text
│   │   ├── medsiglip_loader.py     # MedSigLIP image encoder
│   │   └── forecaster.py           # Time-series forecasting (diffusion / statistical)
│   ├── data/
│   │   ├── __init__.py
│   │   ├── syndromic_schema.py     # Pydantic schemas for extracted signals
│   │   ├── synthetic_generator.py  # Generate training data for LoRA fine-tune
│   │   └── disease_definitions.py  # WHO ICD-10 syndromic surveillance categories
│   ├── utils/
│   │   ├── __init__.py
│   │   ├── anomaly_detection.py    # CUSUM, Poisson thresholds
│   │   ├── fhir_generator.py       # FHIR-compatible report output
│   │   └── geo_utils.py            # Location handling
│   ├── api/
│   │   ├── __init__.py
│   │   └── app.py                  # FastAPI backend
│   └── frontend/                   # React dashboard (later)
├── notebooks/
│   ├── 01_syndromic_extraction_baseline.ipynb
│   ├── 02_lora_finetune_syndromic.ipynb
│   ├── 03_image_triage_demo.ipynb
│   ├── 04_surveillance_analytics.ipynb
│   └── 05_full_pipeline_demo.ipynb
├── scripts/
│   ├── generate_training_data.py
│   ├── run_finetune.py
│   └── run_evaluation.py
├── tests/
│   └── test_extraction.py
└── docs/
    ├── technical_overview.md        # 3-page writeup for submission
    └── architecture_diagram.png
```

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

**Training Data**: We generate ~2,000 synthetic clinical encounter → structured extraction pairs
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
# Clone and setup
git clone <repo>
cd epicast
pip install -r requirements.txt

# Set Hugging Face token (must have accepted MedGemma terms)
export HF_TOKEN=your_token_here

# Generate synthetic training data
python scripts/generate_training_data.py

# Run LoRA fine-tuning
python scripts/run_finetune.py

# Launch the app
python -m src.api.app
```

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
