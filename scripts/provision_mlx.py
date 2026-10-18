"""Download the pinned candidate and inventory it; never certify model parity."""
import argparse
import hashlib
import json
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

REPOSITORY = 'mlx-community/medgemma-1.5-4b-it-4bit'
REVISION = '762746b7a72b0b68dd8fa3f9aea5dc3980674d23'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='models/medgemma-1.5-4b-it-4bit')
    args = parser.parse_args()
    info = HfApi().model_info(REPOSITORY, revision=REVISION, files_metadata=True)
    root = Path(snapshot_download(REPOSITORY, revision=REVISION, local_dir=args.output))
    files = {}
    for item in info.siblings:
        path = root / item.rfilename
        if not path.is_file() or path.stat().st_size != item.size:
            raise RuntimeError(f'Missing or incomplete download: {item.rfilename}')
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        checksum = digest.hexdigest()
        if item.lfs and checksum != item.lfs.sha256:
            raise RuntimeError(f'Upstream checksum mismatch: {item.rfilename}')
        files[item.rfilename] = checksum
    manifest_path = root / 'epicast-artifact.json'
    if manifest_path.exists():
        raise RuntimeError('Manifest exists; preserve validation evidence or select another output directory')
    manifest_path.write_text(json.dumps({
        'base_model': 'google/medgemma-1.5-4b-it', 'source_repository': REPOSITORY,
        'revision': info.sha, 'quantization_bits': 4,
        'text_parity_passed': False, 'image_parity_passed': False,
        'experimental': True, 'sha256': files,
    }, indent=2) + '\n')
    print(manifest_path)


if __name__ == '__main__':
    main()
