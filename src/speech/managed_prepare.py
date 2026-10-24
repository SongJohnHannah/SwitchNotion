"""Explicit setup step only. Runtime ASR worker remains network-disabled."""
import argparse
from pathlib import Path
from huggingface_hub import snapshot_download
parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
args = parser.parse_args()
root = Path(args.root)
if not root.is_absolute():
    raise SystemExit('Absolute setup directory required')
snapshot_download('Systran/faster-whisper-medium',
    revision='08e178d48790749d25932bbc082711ddcfdfbc4f',
    local_dir=root / 'speech/faster-whisper-medium',
    allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt', 'preprocessor_config.json'])
