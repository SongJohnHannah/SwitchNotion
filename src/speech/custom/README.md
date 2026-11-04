# Custom Whisper CUDA operators (Windows x64 only)

This directory is the self-developed GPU path. It is loaded only on Windows x64
with an NVIDIA driver; macOS and other platforms continue to use the
faster-whisper backend.

- `ops/*.cu`: sm_75 kernels compiled to `ops/*.cubin` by `build.cmd`.
- `driver.py`: standalone CUDA Driver API loader (ctypes, no PyTorch).
- `engine.py`: correctness-first Whisper orchestrator.
- `verify_ops.py`: NumPy reference checks for every operator.
- `reference_whisper.py`: Transformers reference used only during development.
- `soak_varied.mjs`: varied-text GPU stability test.

Build (Windows, CUDA 13.3 + MSVC BuildTools):

```cmd
src\speech\custom\build.cmd
```

Verify:

```cmd
C:\Users\songf\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe src\speech\custom\verify_ops.py
```
