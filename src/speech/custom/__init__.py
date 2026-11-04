"""Windows x64 CUDA operators for the self-developed Whisper engine.

This package is intentionally isolated: only Windows x64 with an NVIDIA driver
and locally built sm_75 cubins may import it. macOS and other platforms keep
using the faster-whisper backend.
"""
import ctypes
import sys
from pathlib import Path

WINDOWS = sys.platform == 'win32'
OPS = Path(__file__).resolve().parent / 'ops'
REQUIRED = ('linear', 'gemm', 'layer_norm', 'softmax', 'gelu', 'conv1d', 'attention', 'elementwise', 'simple')


def available():
    if not WINDOWS:
        return False
    try:
        ctypes.WinDLL('nvcuda.dll')
    except OSError:
        return False
    return all((OPS / f'{name}.cubin').is_file() for name in REQUIRED)


def require():
    if not WINDOWS:
        raise RuntimeError('自定义 CUDA 算子仅支持 Windows x64')
    if not available():
        raise RuntimeError('本机 CUDA 驱动或自定义算子 cubin 不可用，请重新构建')
