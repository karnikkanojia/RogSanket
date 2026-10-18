"""Persistent subprocess worker; newline JSON protocol also used by native workers.

Only local model paths are accepted. No inference request downloads weights.
"""
import gc
import json
import platform
import sys
import time


class Worker:
    def __init__(self, settings):
        self.settings = settings
        self.model = self.processor = None
        self.manifest = None
        self.active = None
        self.siglip = self.siglip_processor = None
        self.asr = None
        self.load_seconds = 0.0

    def unload(self):
        self.model = self.processor = self.siglip = self.siglip_processor = self.asr = None
        gc.collect()
        if self.active == "mlx":
            import mlx.core as mx
            mx.clear_cache()
        self.active = None

    def load(self):
        if self.model is not None:
            return
        from .memory import admit
        admit()
        self.unload()
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            raise RuntimeError("MLX requires native ARM64 Python on Apple Silicon")
        if self.settings.backend != "mlx":
            raise RuntimeError("Only the verified MLX runtime is currently enabled")
        start = time.monotonic()
        self.manifest = self.settings.manifest()
        from mlx_vlm import load
        self.model, self.processor = load(self.settings.artifact)
        self.active = "mlx"
        self.load_seconds = time.monotonic() - start

    def generate(self, request):
        request_start = time.monotonic()
        self.load()
        preprocessing_start = time.monotonic()
        import mlx.core as mx
        from mlx_vlm import stream_generate, prepare_inputs
        from mlx_vlm.utils import should_add_special_tokens
        from mlx_vlm.prompt_utils import apply_chat_template
        from PIL import Image
        import base64
        import io
        images = request.get("images") or []
        if len(images) > 1:
            raise ValueError("Only one image per task is supported")
        image = None
        if images:
            image = Image.open(io.BytesIO(base64.b64decode(images[0], validate=True)))
            if image.width * image.height > 16_000_000:
                raise ValueError("Image exceeds 16 megapixels")
            image = image.convert("RGB")
        messages = request["messages"]
        prompt = apply_chat_template(self.processor, self.model.config, messages, num_images=1 if image else 0)
        inputs = prepare_inputs(self.processor, images=image, prompts=prompt,
            image_token_index=getattr(self.model.config, "image_token_index", None),
            add_special_tokens=should_add_special_tokens(self.model.config.model_type, self.processor))
        tokens = int(inputs["input_ids"].size)
        prepared = {key: value for key, value in inputs.items() if key != "attention_mask"}
        prepared["mask"] = inputs.get("attention_mask")
        preprocessing_seconds = time.monotonic() - preprocessing_start
        output = min(request.get("max_tokens", 512), 1024)
        if output < 1 or tokens + output > self.settings.context_tokens:
            raise ValueError("Input plus output exceeds the 4096-token text budget")
        start = time.monotonic()
        mx.reset_peak_memory()
        first = None
        text = []
        count = 0
        try:
            for result in stream_generate(
                self.model, self.processor, prompt, image=image,
                max_tokens=output, temperature=request.get("temperature", 0.0),
                prefill_step_size=256, **prepared,
            ):
                if time.time() > request["deadline"]:
                    raise TimeoutError("Inference deadline exceeded")
                first = first or time.monotonic()
                text.append(result.text)
                count = result.generation_tokens
                tokens = result.prompt_tokens
            mx.synchronize()
            return {"text": "".join(text), "provenance": {
                "model": self.manifest["base_model"], "revision": self.manifest["revision"],
                "backend": "mlx-vlm", "quantization": "4bit", "location": "local",
                "prompt_tokens": tokens, "generated_tokens": count,
                "load_seconds": self.load_seconds,
                "preprocessing_seconds": preprocessing_seconds,
                "worker_seconds": time.monotonic() - request_start,
                "first_token_seconds": first - start if first else None,
                "generation_seconds": time.monotonic() - start,
                "prompt_tokens_per_second": result.prompt_tps if count else None,
                "generation_tokens_per_second": result.generation_tps if count else None,
                "mlx_active_bytes": mx.get_active_memory(), "mlx_peak_bytes": mx.get_peak_memory(),
            }}
        finally:
            # No encounter cache survives a request.
            mx.clear_cache()

    def release_auxiliary(self):
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None and torch.backends.mps.is_available():
            torch.mps.synchronize()
            torch.mps.empty_cache()

    def transcribe(self, request):
        from .modalities import transcribe
        self.unload()
        try:
            return transcribe(request)
        finally:
            self.release_auxiliary()

    def image(self, request):
        from .modalities import classify_image
        self.unload()
        try:
            return classify_image(request)
        finally:
            self.release_auxiliary()

    def cough(self, request):
        from .modalities import classify_cough
        self.unload()
        return classify_cough(request)

    def dispatch(self, request):
        if time.time() > request.get("deadline", float("inf")):
            raise TimeoutError("Request expired before execution")
        from .memory import admit
        try:
            admit()
        except MemoryError:
            self.unload()
            raise
        operation = request["operation"]
        if operation not in {"generate", "image", "transcribe", "cough", "unload"}:
            raise ValueError("Unsupported worker operation")
        if operation == "unload":
            self.unload()
            return {"unloaded": True}
        return getattr(self, operation)(request)


def main():
    from .config import Settings
    worker = Worker(Settings.from_env())
    # Third-party progress output must never corrupt protocol stdout.
    output = sys.stdout
    sys.stdout = sys.stderr
    for line in sys.stdin:
        try:
            result = {"result": worker.dispatch(json.loads(line))}
        except Exception as exc:
            result = {"error": str(exc), "error_type": type(exc).__name__}
        output.write(json.dumps(result) + "\n")
        output.flush()


if __name__ == "__main__":
    main()
