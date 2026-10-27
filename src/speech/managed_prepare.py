"""Explicit setup step only. Runtime ASR worker remains network-disabled."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from huggingface_hub import hf_hub_download, snapshot_download
from tqdm.auto import tqdm

class ModelProgress(tqdm):
    """Report the model file's actual bytes, including any resumed partial download."""
    def __init__(self, *args, **kwargs):
        kwargs.pop('name', None)
        kwargs['disable'] = False
        self.output = open(os.devnull, 'w')
        kwargs['file'] = self.output
        super().__init__(*args, **kwargs)
        self.last_time = time.monotonic()
        self.last_bytes = self.n
        self.report(0)

    def report(self, speed):
        print('SWITCH_NOTION_PROGRESS ' + json.dumps({'received': self.n, 'total': self.total, 'bytesPerSecond': speed}), flush=True)

    def update(self, amount=1):
        result = super().update(amount)
        now = time.monotonic()
        elapsed = now - self.last_time
        if elapsed >= 0.5 or (self.total and self.n >= self.total):
            self.report(max(0, (self.n - self.last_bytes) / elapsed) if elapsed else 0)
            self.last_time, self.last_bytes = now, self.n
        return result

    def close(self):
        super().close()
        self.output.close()
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
hf_hub_download(model['repository'], filename='model.bin', revision=model['revision'], local_dir=directory,
    token=False, tqdm_class=ModelProgress)
snapshot_download(model['repository'], revision=model['revision'], local_dir=directory,
    allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt', 'vocabulary.json', 'preprocessor_config.json'], token=False)
if model.get('sha256'):
    with (directory / 'model.bin').open('rb') as data:
        if hashlib.file_digest(data, 'sha256').hexdigest() != model['sha256']:
            raise RuntimeError('Downloaded speech model checksum mismatch')
