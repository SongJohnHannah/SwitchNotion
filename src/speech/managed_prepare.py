"""Explicit setup step only. Runtime ASR worker remains network-disabled."""
import argparse
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download
parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
models = json.loads((Path(__file__).parent / 'models.json').read_text('utf-8'))
parser.add_argument('--model', choices=list(models), default='medium')
args = parser.parse_args()
root = Path(args.root)
if not root.is_absolute():
    raise SystemExit('Absolute setup directory required')
model = models[args.model]
directory = root / ('speech/faster-whisper-' + args.model)
snapshot_download(model['repository'], revision=model['revision'], local_dir=directory,
    allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt', 'vocabulary.json', 'preprocessor_config.json'], token=False)
if model.get('sha256'):
    with (directory / 'model.bin').open('rb') as data:
        if hashlib.file_digest(data, 'sha256').hexdigest() != model['sha256']:
            raise RuntimeError('Downloaded speech model checksum mismatch')
