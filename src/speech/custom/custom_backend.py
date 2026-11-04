"""JSONL worker backend for the Windows-only self-developed CUDA engine."""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

if sys.platform != 'win32':
    raise ImportError('Custom Whisper backend is Windows-only')

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from engine import WhisperEngine
from faster_backend import discover as ct2_discover

OPS = HERE / 'ops'
REQUIRED = ('linear', 'gemm', 'layer_norm', 'softmax', 'gelu', 'conv1d', 'attention', 'elementwise', 'simple')
if not all((OPS / f'{name}.cubin').is_file() for name in REQUIRED):
    raise RuntimeError('自定义 Whisper 算子 cubin 未构建')


def discover(root, model='medium'):
    runtime = ct2_discover(root, model)
    return {**runtime, 'device': 'cuda', 'computeType': 'float32'}


def model_directory(runtime):
    override = os.environ.get('NOTION_SWITCH_WHISPER_HF')
    if override:
        return Path(override)
    base = Path(runtime['modelDirectory']).parent
    model = runtime.get('model', 'large-v3-turbo')
    candidate = base / f'whisper-{model}-hf'
    if candidate.is_dir():
        return candidate
    raise RuntimeError(f'未找到自研引擎权重目录：{candidate}')


class CustomWhisper:
    def __init__(self, engine, status):
        self.engine = engine
        self.status = status

    def transcribe(self, chunk, language=None, **kwargs):
        requested = language if language in ('zh', 'en') else 'auto'
        text, _tokens, _encoder, used = self.engine.transcribe_pcm(chunk, requested, max_tokens=128)
        self.engine.free_temporaries()
        segment = SimpleNamespace(start=0, end=len(chunk) / 16000, text=text,
                                  avg_logprob=-0.2, no_speech_prob=0.0, compression_ratio=1.0)
        return [segment], SimpleNamespace(language=used)


def configure(runtime):
    engine = WhisperEngine(model_directory(runtime))
    status = {'platform': 'win32', 'architecture': 'x64', 'device': 'cuda', 'computeType': 'float32',
              'provider': 'custom-whisper', 'model': runtime.get('model', 'large-v3-turbo'),
              'protocolVersion': 1, 'offline': True, 'hardwareLabel': 'NVIDIA GPU'}
    return CustomWhisper(engine, status), status
