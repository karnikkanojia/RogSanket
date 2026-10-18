# RunPod verification setup

A running Pod alone is insufficient: EpiCast needs an authenticated,
OpenAI-compatible `/v1/chat/completions` endpoint. `handler.py` is an application
transport adapter, not a CUDA model loader. Do not use it to host 27B.

## Operator preparation

1. Accept the terms for `google/medgemma-27b-text-it` using the Hugging Face
   account whose read token will be available inside the Pod. Access to the 4B
   repository does not prove access to this repository.
2. For the first unquantized baseline, provision one A100 80 GB or H100 80 GB
   GPU. This is an initial capacity recommendation, not a certified profile.
   BF16 27B weights alone need approximately 54 GB. Reserve at least 100 GB
   persistent disk for weights/cache and additional space for the runtime image.
   A 24 GB card requires a separately validated quantized deployment.
3. Use a CUDA-compatible vLLM image with an explicit version and image digest.
   Record the image digest, GPU, driver, vLLM version and exact model revision.
   No GPU image has yet been validated by this checkout; do not label it tested.
4. Set `HF_TOKEN`, `VLLM_API_KEY` and `MODEL_REVISION` inside the Pod using its
   secret/environment configuration. `MODEL_REVISION` must be the chosen model's
   full Hugging Face commit hash. Never commit these secrets.
5. Expose port 8000 as HTTP. The RunPod proxy provides HTTPS. Restrict exposed
   routes with a gateway to `/v1/chat/completions` and authenticated model
   discovery if needed: vLLM's API key does not protect every administrative route.

Inside the selected vLLM environment, start the text-only model:

```sh
vllm serve google/medgemma-27b-text-it \
  --revision "$MODEL_REVISION" \
  --served-model-name google/medgemma-27b-text-it \
  --dtype bfloat16 \
  --max-model-len 4096 \
  --max-num-seqs 1 \
  --gpu-memory-utilization 0.85 \
  --host 0.0.0.0 --port 8000
```

`VLLM_API_KEY` enables authentication. Keep the exact startup log and resolved
configuration as deployment evidence. If the chosen vLLM release does not support
this exact checkpoint, stop and validate a compatible release instead of changing
models silently. This command is a deployment candidate, not a verified image.

## Connect the Mac

Set these variables in the shell that starts EpiCast Server, with the token entered
locally rather than pasted into chat:

```sh
export EPICAST_REMOTE_27B_URL='https://POD_ID-8000.proxy.runpod.net/v1/chat/completions'
# Set EPICAST_REMOTE_TOKEN securely to the Pod's VLLM_API_KEY.
.venv/bin/python scripts/probe_remote.py
```

The probe sends synthetic counts only. It checks response shape, model name and
latency. A server-supplied model name is not proof of loaded weights. Supply the
non-secret endpoint URL, GPU type, image digest and model revision for integration.
A RunPod account API key is not needed by EpiCast. The current service uses a
60-second remote timeout and falls back to local 4B when remote reporting fails.

## Verification order

Use the same GPU sequentially:

1. Run `google/medgemma-1.5-4b-it` revision
   `91850547d9f0b2fdd21aa7c5f4f3d1a8a52c243b` to obtain original text and image
   reference outputs. This validates the local 4B conversion; 27B cannot serve as
   its reference. Record original processor behavior and output probabilities
   where feasible, rather than expecting identical quantized prose.
2. Stop the 4B process and release GPU memory. Start pinned 27B.
3. Test synthetic aggregate report counts, absence of fabricated evidence,
   authentication failures, timeout/fallback and repeat latency. Generated
   recommendations remain drafts.
4. Enable remote reporting only after these checks pass. Unset
   `EPICAST_REMOTE_27B_URL` to restore local-only operation.

The inherited `data/evaluation_frozen.jsonl` is synthetic and contains inconsistent
labels. For example, row 25 describes mild dehydration and an alert patient but
labels severity critical and adds unsupported travel/contact history. These labels
require clinical review before they can gate accuracy. Failed requests still count
as failures. Do not mistake original-model agreement for clinical correctness.

Stop the Pod after testing; check retained storage separately. No paid Pod is
created or started by these repository scripts.

Sources: [RunPod HTTP proxy](https://github.com/runpod/docs/blob/main/integrations/overview.mdx),
[vLLM serve options](https://docs.vllm.ai/en/stable/cli/serve/),
[vLLM endpoint authentication](https://docs.vllm.ai/en/latest/usage/security/),
[MedGemma model terms](https://huggingface.co/google/medgemma-27b-text-it).
