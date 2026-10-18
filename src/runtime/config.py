"""Central runtime settings. Model downloads are an explicit provisioning step."""
from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database: str = "data/epicast.sqlite3"
    artifact: str = ""
    backend: str = "mlx"
    context_tokens: int = 4096
    queue_size: int = 8
    timeout_seconds: int = 180
    remote_url: str = ""
    remote_model: str = "google/medgemma-27b-text-it"

    @classmethod
    def from_env(cls):
        return cls(
            database=os.getenv("EPICAST_DATABASE", "data/epicast.sqlite3"),
            artifact=os.getenv("EPICAST_ARTIFACT", ""),
            backend=os.getenv("EPICAST_BACKEND", "mlx"),
            remote_url=os.getenv("EPICAST_REMOTE_27B_URL", ""),
        )

    def __post_init__(self):
        if self.backend not in {"mlx", "swift"}:
            raise ValueError("EPICAST_BACKEND must be mlx or swift")
        if self.queue_size < 1 or self.context_tokens < 1 or self.timeout_seconds < 1:
            raise ValueError("Runtime limits must be positive")
        if self.remote_url:
            from urllib.parse import urlparse
            url = urlparse(self.remote_url)
            if url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password:
                raise ValueError("Remote URL must be an HTTP(S) endpoint without embedded credentials")
            if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
                raise ValueError("Remote reporting requires HTTPS outside localhost")

    def manifest(self, *, require_parity=True):
        import json
        if not self.artifact:
            raise RuntimeError("EPICAST_ARTIFACT must name a verified local artifact directory")
        root = Path(self.artifact).resolve()
        manifest = json.loads((root / "epicast-artifact.json").read_text())
        if manifest.get("base_model") != "google/medgemma-1.5-4b-it":
            raise RuntimeError("Artifact base must be google/medgemma-1.5-4b-it")
        if not manifest.get("revision") or manifest.get("quantization_bits") != 4:
            raise RuntimeError("Artifact requires a pinned revision and four-bit weights")
        if require_parity and (not manifest.get("text_parity_passed") or not manifest.get("image_parity_passed")):
            raise RuntimeError("Artifact text/image parity has not passed")
        # Reject unverified or modified files, including processor and tokenizer assets.
        import hashlib
        files = manifest.get("sha256", {})
        if not files or not any(name.endswith(".safetensors") for name in files):
            raise RuntimeError("Artifact requires checksums for weights and processor assets")
        required = {str(path.relative_to(root)) for path in root.rglob("*")
                    if path.is_file() and (path.suffix in {".safetensors", ".json", ".model", ".txt", ".jinja"})
                    and path.name != "epicast-artifact.json"
                    and ".cache" not in path.relative_to(root).parts}
        if not {"config.json", "tokenizer_config.json"}.issubset(files) or not required.issubset(files):
            raise RuntimeError("Artifact checksums must cover all weights, tokenizer and processor files")
        config = json.loads((root / "config.json").read_text())
        if config.get("model_type") != "gemma3" or "vision_config" not in config:
            raise RuntimeError("Artifact must retain the Gemma 3 vision configuration")
        quantization = config.get("quantization", config.get("quantization_config", {}))
        if quantization.get("bits") != 4:
            raise RuntimeError("Converted artifact configuration must specify four-bit quantization")
        for name, expected in files.items():
            path = (root / name).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise RuntimeError("Invalid artifact file")
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise RuntimeError(f"Artifact checksum failed: {name}")
        return manifest
