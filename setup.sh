#!/usr/bin/env bash
# =============================================================================
# EpiCast Setup Script
# Run this on your H100 machine to set up everything
# =============================================================================

set -e

echo "============================================="
echo "  EpiCast - Setup Script"
echo "============================================="

# -----------------------------------------
# Step 0: Check prerequisites
# -----------------------------------------
echo ""
echo "[Step 0] Checking prerequisites..."

if ! command -v python3 &> /dev/null; then
    echo "ERROR: python3 not found. Install Python 3.10+"
    exit 1
fi

if ! python3 -c "import torch; assert torch.cuda.is_available()" 2>/dev/null; then
    echo "WARNING: CUDA not detected. You need a GPU for this project."
    echo "Continuing anyway (some steps will still work)..."
fi

# -----------------------------------------
# Step 1: Install dependencies
# -----------------------------------------
echo ""
echo "[Step 1] Installing Python dependencies..."
pip install -r requirements.txt --quiet

# -----------------------------------------
# Step 2: Hugging Face authentication
# -----------------------------------------
echo ""
echo "[Step 2] Hugging Face Authentication"
echo ""

if [ -z "$HF_TOKEN" ]; then
    echo "HF_TOKEN not set."
    echo ""
    echo "BEFORE running this script, you need to:"
    echo "  1. Create a Hugging Face account: https://huggingface.co/join"
    echo "  2. Go to https://huggingface.co/google/medgemma-4b-it"
    echo "     → Click 'Agree and access repository' (accept the license)"
    echo "  3. Do the same for these models:"
    echo "     - https://huggingface.co/google/medgemma-1.5-4b-it"
    echo "     - https://huggingface.co/google/medgemma-27b-text-it"
    echo "     - https://huggingface.co/google/medasr"
    echo "     - https://huggingface.co/google/medsiglip"
    echo "  4. Create an access token: https://huggingface.co/settings/tokens"
    echo "     → New token → 'Read' access is sufficient"
    echo "  5. Run: export HF_TOKEN=hf_your_token_here"
    echo ""
    read -p "Enter your HF token now (or Ctrl+C to exit): " HF_TOKEN
    export HF_TOKEN
fi

echo "Logging in to Hugging Face..."
python3 -c "from huggingface_hub import login; login(token='${HF_TOKEN}')"
echo "✓ Logged in successfully"

# -----------------------------------------
# Step 3: Download models (this takes time!)
# -----------------------------------------
echo ""
echo "[Step 3] Downloading models..."
echo "This will download ~10-70GB depending on which models you want."
echo ""

# Priority 1: MedGemma 4B (REQUIRED)
echo "Downloading MedGemma 1.5 4B (required, ~8GB)..."
python3 -c "
from transformers import AutoProcessor, AutoModelForImageTextToText
import torch

print('  Downloading processor...')
processor = AutoProcessor.from_pretrained('google/medgemma-4b-it')
print('  Downloading model weights...')
model = AutoModelForImageTextToText.from_pretrained(
    'google/medgemma-4b-it',
    torch_dtype=torch.bfloat16,
    device_map='auto',
)
print('  ✓ MedGemma 4B downloaded and loaded successfully')
print(f'  Device: {model.device}')
del model  # Free memory
" 2>&1 | grep -E "(Downloading|✓|Device|Error|error)"

echo ""
echo "✓ MedGemma 4B ready"

# Priority 2: MedGemma 27B (optional but recommended)
read -p "Download MedGemma 27B text model? (~54GB, needed for full mode) [y/N]: " dl_27b
if [[ "$dl_27b" =~ ^[Yy]$ ]]; then
    echo "Downloading MedGemma 27B text-only..."
    python3 -c "
from transformers import AutoProcessor, AutoModelForCausalLM, BitsAndBytesConfig
import torch
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16)
proc = AutoProcessor.from_pretrained('google/medgemma-27b-text-it')
model = AutoModelForCausalLM.from_pretrained('google/medgemma-27b-text-it', quantization_config=bnb, device_map='auto')
print('  ✓ MedGemma 27B downloaded')
del model
" 2>&1 | grep -E "(Downloading|✓|Error)"
fi

# Priority 3: MedASR (optional)
read -p "Download MedASR speech model? (~3GB, for voice input) [y/N]: " dl_asr
if [[ "$dl_asr" =~ ^[Yy]$ ]]; then
    echo "Downloading MedASR..."
    python3 -c "
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
model = AutoModelForSpeechSeq2Seq.from_pretrained('google/medasr', device_map='auto')
proc = AutoProcessor.from_pretrained('google/medasr')
print('  ✓ MedASR downloaded')
del model
" 2>&1 | grep -E "(Downloading|✓|Error)"
fi

# -----------------------------------------
# Step 4: Generate training data
# -----------------------------------------
echo ""
echo "[Step 4] Generating synthetic training data..."
python3 scripts/generate_training_data.py --num_examples 2000 --output data/syndromic_training_data.jsonl
echo "✓ Training data generated"

# -----------------------------------------
# Step 5: Quick verification
# -----------------------------------------
echo ""
echo "[Step 5] Verification..."

# Test data loading
python3 -c "
import json
count = 0
with open('data/syndromic_training_data.jsonl') as f:
    for line in f:
        count += 1
print(f'  ✓ Training data: {count} examples')
"

# Test anomaly detection
python3 -c "
from src.utils.anomaly_detection import detect_anomalies
import numpy as np
np.random.seed(42)
counts = np.concatenate([np.random.poisson(5, 8), np.array([12, 18, 25])])
result = detect_anomalies(counts, baseline_weeks=8, method='combined')
assert result['alarm'] == True
print('  ✓ Anomaly detection: working')
"

# Test schema
python3 -c "
from src.data.syndromic_schema import SyndromicSignal
signal = SyndromicSignal(
    symptoms=['fever', 'cough'],
    syndrome_category='acute_respiratory_infection',
    severity='moderate',
    age_group='adult',
    icd10_codes=['J06'],
    confidence_score=0.85
)
print(f'  ✓ Schema validation: working ({signal.syndrome_category})')
"

echo ""
echo "============================================="
echo "  Setup Complete!"
echo "============================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. FINE-TUNE (run on GPU, takes ~1-2 hours):"
echo "     python scripts/run_finetune.py"
echo ""
echo "  2. EVALUATE baseline vs fine-tuned:"
echo "     python scripts/run_evaluation.py --baseline"
echo "     python scripts/run_evaluation.py --model_path checkpoints/syndromic_extraction_lora"
echo ""
echo "  3. RUN THE APP:"
echo "     python -m src.api.app"
echo "     # Then open http://localhost:8000/docs for API docs"
echo ""
echo "  4. EDGE MODE (4B only, no internet needed):"
echo "     EPICAST_EDGE_MODE=true python -m src.api.app"
echo ""
