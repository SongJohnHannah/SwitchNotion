"""Numerical verification for the custom Whisper cubin operators."""
import ctypes
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import CudaDriver

ROOT = Path(__file__).resolve().parent
OPS = ROOT / 'ops'
driver = CudaDriver()


def upload(array):
    array = np.ascontiguousarray(array)
    pointer = driver.malloc(array.nbytes)
    host = driver.h2d(pointer, array.tobytes())
    return pointer, host


def download(pointer, shape, dtype):
    count = int(np.prod(shape))
    buffer = driver.d2h(pointer, count * np.dtype(dtype).itemsize)
    return np.frombuffer(buffer, dtype=dtype).reshape(shape).copy()


def ptr(value):
    return ctypes.c_void_p(value)


def check(name, actual, expected, tolerance):
    error = float(np.max(np.abs(actual.astype(np.float64) - expected.astype(np.float64))))
    print(f'{name}: max_abs_error={error:.6g}')
    if not math.isfinite(error) or error > tolerance:
        raise AssertionError(f'{name} failed (max error {error} > {tolerance})')


def test_linear_f32():
    rng = np.random.default_rng(1)
    x = rng.normal(size=(4, 8)).astype(np.float32)
    w = rng.normal(size=(5, 8)).astype(np.float32)
    b = rng.normal(size=5).astype(np.float32)
    xp, xh = upload(x)
    wp, wh = upload(w)
    bp, bh = upload(b)
    yp = driver.malloc(4 * 5 * 4)
    fn = driver.function(OPS / 'linear.cubin', 'whisper_linear_f32')
    driver.launch(fn, (20, 1, 1), (128, 1, 1), [xp, wp, bp, yp, ctypes.c_int(4), ctypes.c_int(5), ctypes.c_int(8)])
    check('linear_f32', download(yp, (4, 5), np.float32), x @ w.T + b, 1e-5)


def test_linear_f16():
    rng = np.random.default_rng(2)
    x = rng.normal(size=(4, 8)).astype(np.float16)
    w = rng.normal(size=(5, 8)).astype(np.float16)
    b = rng.normal(size=5).astype(np.float16)
    xp, _ = upload(x)
    wp, _ = upload(w)
    bp, _ = upload(b)
    yp = driver.malloc(4 * 5 * 2)
    fn = driver.function(OPS / 'linear.cubin', 'whisper_linear_f16')
    driver.launch(fn, (20, 1, 1), (128, 1, 1), [xp, wp, bp, yp, ctypes.c_int(4), ctypes.c_int(5), ctypes.c_int(8)])
    expected = x.astype(np.float32) @ w.astype(np.float32).T + b.astype(np.float32)
    check('linear_f16', download(yp, (4, 5), np.float16).astype(np.float32), expected, 2e-2)


def test_layer_norm():
    rng = np.random.default_rng(3)
    x = rng.normal(size=(4, 1280)).astype(np.float32)
    w = rng.normal(size=1280).astype(np.float32)
    b = rng.normal(size=1280).astype(np.float32)
    xp, _ = upload(x)
    wp, _ = upload(w)
    bp, _ = upload(b)
    yp = driver.malloc(x.nbytes)
    fn = driver.function(OPS / 'layer_norm.cubin', 'whisper_layer_norm_f32')
    driver.launch(fn, (4, 1, 1), (256, 1, 1), [xp, wp, bp, yp, ctypes.c_int(4), ctypes.c_int(1280), ctypes.c_float(1e-5)])
    mean = x.mean(axis=1, keepdims=True)
    variance = x.var(axis=1, keepdims=True)
    expected = (x - mean) / np.sqrt(variance + 1e-5) * w + b
    check('layer_norm_f32', download(yp, x.shape, np.float32), expected, 2e-4)


def test_softmax():
    rng = np.random.default_rng(4)
    x = rng.normal(size=(3, 7)).astype(np.float32)
    xp, _ = upload(x)
    fn = driver.function(OPS / 'softmax.cubin', 'whisper_softmax_f32')
    driver.launch(fn, (3, 1, 1), (256, 1, 1), [xp, ctypes.c_int(3), ctypes.c_int(7)])
    values = download(xp, x.shape, np.float32)
    expected = np.exp(x - x.max(axis=1, keepdims=True))
    expected /= expected.sum(axis=1, keepdims=True)
    check('softmax_f32', values, expected, 1e-6)


def test_gelu():
    rng = np.random.default_rng(5)
    x = rng.normal(size=1000).astype(np.float32)
    xp, _ = upload(x)
    fn = driver.function(OPS / 'gelu.cubin', 'whisper_gelu_f32')
    driver.launch(fn, (math.ceil(1000 / 256), 1, 1), (256, 1, 1), [xp, ctypes.c_int(1000)])
    expected = 0.5 * x * (1.0 + np.vectorize(math.erf)(x / math.sqrt(2.0)))
    check('gelu_f32', download(xp, x.shape, np.float32), expected.astype(np.float32), 2e-6)


def test_conv1d():
    rng = np.random.default_rng(6)
    length, in_channels, out_channels, stride, padding = 10, 3, 4, 2, 1
    out_length = (length + 2 * padding - 3) // stride + 1
    x = rng.normal(size=(in_channels, length)).astype(np.float32)
    w = rng.normal(size=(out_channels, in_channels, 3)).astype(np.float32)
    b = rng.normal(size=out_channels).astype(np.float32)
    xp, _ = upload(x)
    wp, _ = upload(w)
    bp, _ = upload(b)
    yp = driver.malloc(out_channels * out_length * 4)
    fn = driver.function(OPS / 'conv1d.cubin', 'whisper_conv1d_k3_f32')
    driver.launch(fn, (out_channels * out_length, 1, 1), (128, 1, 1),
                  [xp, wp, bp, yp, ctypes.c_int(length), ctypes.c_int(out_length), ctypes.c_int(in_channels),
                   ctypes.c_int(out_channels), ctypes.c_int(stride), ctypes.c_int(padding)])
    expected = np.zeros((out_channels, out_length), dtype=np.float32)
    for channel in range(out_channels):
        for position in range(out_length):
            total = b[channel]
            for input_channel in range(in_channels):
                for tap in range(3):
                    source = position * stride - padding + tap
                    if 0 <= source < length:
                        total += x[input_channel, source] * w[channel, input_channel, tap]
            expected[channel, position] = total
    check('conv1d_k3_f32', download(yp, expected.shape, np.float32), expected, 2e-5)


def test_attention():
    rng = np.random.default_rng(7)
    heads, query_length, key_length, head_dim = 2, 3, 5, 8
    q = rng.normal(size=(heads, query_length, head_dim)).astype(np.float32)
    k = rng.normal(size=(heads, key_length, head_dim)).astype(np.float32)
    v = rng.normal(size=(heads, key_length, head_dim)).astype(np.float32)
    scale = 1.0 / math.sqrt(head_dim)
    for causal in (0, 1):
        qp, _ = upload(q)
        kp, _ = upload(k)
        vp, _ = upload(v)
        op = driver.malloc(q.nbytes)
        fn = driver.function(OPS / 'attention.cubin', 'whisper_attention_f32')
        driver.launch(fn, (heads, query_length, 1), (128, 1, 1),
                      [qp, kp, vp, op, ctypes.c_int(query_length), ctypes.c_int(key_length),
                       ctypes.c_int(heads), ctypes.c_int(head_dim), ctypes.c_int(causal), ctypes.c_float(scale)],
                      shared=key_length * 4)
        scores = np.einsum('hqd,hkd->hqk', q, k) * scale
        if causal:
            mask = np.arange(key_length)[None, :] > np.arange(query_length)[:, None]
            scores = np.where(mask[None], -np.inf, scores)
        weights = np.exp(scores - scores.max(axis=2, keepdims=True))
        weights /= weights.sum(axis=2, keepdims=True)
        expected = np.einsum('hqk,hkd->hqd', weights, v)
        check(f'attention_f32(causal={causal})', download(op, q.shape, np.float32), expected, 2e-5)


def test_elementwise():
    rng = np.random.default_rng(8)
    a = rng.normal(size=100).astype(np.float32)
    b = rng.normal(size=100).astype(np.float32)
    ap, _ = upload(a)
    bp, _ = upload(b)
    fn = driver.function(OPS / 'elementwise.cubin', 'whisper_add_f32')
    driver.launch(fn, (1, 1, 1), (128, 1, 1), [ap, bp, ctypes.c_int(100)])
    check('add_f32', download(ap, a.shape, np.float32), a + b, 1e-6)

    tokens = np.array([1, 0, 2, 1], dtype=np.int32)
    table = rng.normal(size=(3, 4)).astype(np.float32)
    tp, _ = upload(tokens)
    wp, _ = upload(table)
    op = driver.malloc(4 * 4 * 4)
    fn = driver.function(OPS / 'elementwise.cubin', 'whisper_embedding_f32')
    driver.launch(fn, (1, 1, 1), (128, 1, 1), [tp, wp, op, ctypes.c_int(4), ctypes.c_int(4)])
    check('embedding_f32', download(op, (4, 4), np.float32), table[tokens], 1e-6)

    seq, heads, dim = 3, 2, 5
    source = rng.normal(size=(seq, heads * dim)).astype(np.float32)
    sp, _ = upload(source)
    heads_ptr = driver.malloc(source.nbytes)
    fn = driver.function(OPS / 'elementwise.cubin', 'whisper_transpose_heads_f32')
    driver.launch(fn, (1, 1, 1), (128, 1, 1), [sp, heads_ptr, ctypes.c_int(seq), ctypes.c_int(heads), ctypes.c_int(dim)])
    expected = source.reshape(seq, heads, dim).transpose(1, 0, 2)
    check('transpose_heads_f32', download(heads_ptr, (heads, seq, dim), np.float32), expected, 1e-6)
    merged = driver.malloc(source.nbytes)
    fn = driver.function(OPS / 'elementwise.cubin', 'whisper_merge_heads_f32')
    driver.launch(fn, (1, 1, 1), (128, 1, 1), [heads_ptr, merged, ctypes.c_int(seq), ctypes.c_int(heads), ctypes.c_int(dim)])
    check('merge_heads_f32', download(merged, (seq, heads * dim), np.float32), source, 1e-6)

    logits = rng.normal(size=64).astype(np.float32)
    lp, _ = upload(logits)
    ip = driver.malloc(4)
    fn = driver.function(OPS / 'elementwise.cubin', 'whisper_argmax_f32')
    driver.launch(fn, (1, 1, 1), (256, 1, 1), [lp, ctypes.c_int(64), ip])
    check('argmax_f32', download(ip, (1,), np.int32), np.array([int(logits.argmax())], dtype=np.int32), 0)


def test_linear_tiled():
    rng = np.random.default_rng(9)
    fn = driver.function(OPS / 'gemm.cubin', 'whisper_linear_f32_tiled')
    for rows, outputs, inputs in ((5, 7, 3), (65, 70, 33), (128, 96, 128)):
        x = rng.normal(size=(rows, inputs)).astype(np.float32)
        w = rng.normal(size=(outputs, inputs)).astype(np.float32)
        b = rng.normal(size=outputs).astype(np.float32)
        xp, _ = upload(x)
        wp, _ = upload(w)
        bp, _ = upload(b)
        yp = driver.malloc(rows * outputs * 4)
        driver.launch(fn, (math.ceil(outputs / 64), math.ceil(rows / 64), 1), (256, 1, 1),
                      [xp, wp, bp, yp, ctypes.c_int(rows), ctypes.c_int(outputs), ctypes.c_int(inputs)])
        check(f'linear_tiled_{rows}x{outputs}x{inputs}', download(yp, (rows, outputs), np.float32),
              x @ w.T + b, 5e-5)


if __name__ == '__main__':
    test_linear_f32()
    test_linear_f16()
    test_linear_tiled()
    test_layer_norm()
    test_softmax()
    test_gelu()
    test_conv1d()
    test_attention()
    test_elementwise()
    driver.close()
    print('all operator checks passed')
