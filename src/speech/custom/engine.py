"""Self-developed Whisper large-v3-turbo inference on custom sm_75 cubins.

The kernels live in ./ops and are loaded through the raw CUDA Driver API in
driver.py. This file is deliberately a correctness-first orchestrator; it is
not imported by the shipped worker yet.
"""
import argparse
import ctypes
import json
import math
import mmap
import struct
import sys
import time
from pathlib import Path

if sys.platform != 'win32':
    raise RuntimeError('The custom Whisper CUDA engine is Windows-only')

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import CudaDriver
import mel as mel_frontend

OPS = Path(__file__).resolve().parent / 'ops'
EOS = 50257
NO_TIMESTAMPS = 50363
TIMESTAMP_BEGIN = 50364


class Tensor:
    __slots__ = ('ptr', 'shape')

    def __init__(self, ptr, shape):
        self.ptr = ptr
        self.shape = tuple(int(v) for v in shape)

    @property
    def elements(self):
        return int(np.prod(self.shape))


class Safetensors:
    def __init__(self, path):
        self.handle = open(path, 'rb')
        self.data = mmap.mmap(self.handle.fileno(), 0, access=mmap.ACCESS_READ)
        size = struct.unpack('<Q', self.data[:8])[0]
        self.header = json.loads(self.data[8:8 + size])
        self.base = 8 + size

    def tensor(self, name):
        entry = self.header[name]
        shape = tuple(entry['shape'])
        start, end = entry['data_offsets']
        code = {'F16': np.float16, 'F32': np.float32}[entry['dtype']]
        values = np.frombuffer(self.data, dtype=code, count=int(np.prod(shape)), offset=self.base + start)
        return values.reshape(shape)


class WhisperEngine:
    def __init__(self, model_dir):
        model_dir = Path(model_dir)
        self.model_dir = model_dir
        self.config = json.loads((model_dir / 'config.json').read_text())
        self.generation = json.loads((model_dir / 'generation_config.json').read_text())
        self.driver = CudaDriver()
        self.functions = {}
        self.weights = {}
        self.temporaries = []
        self.persistent = []
        self.file = Safetensors(model_dir / 'model.safetensors')
        for name in self.file.header:
            if name == '__metadata__':
                continue
            values = np.ascontiguousarray(self.file.tensor(name), dtype=np.float32)
            pointer = self.driver.malloc(values.nbytes)
            self.driver.h2d(pointer, values.tobytes())
            self.weights[name] = Tensor(pointer, values.shape)

    def function(self, cubin, name):
        key = (cubin, name)
        if key not in self.functions:
            self.functions[key] = self.driver.function(OPS / f'{cubin}.cubin', name)
        return self.functions[key]

    def alloc(self, shape, track=True):
        tensor = Tensor(self.driver.malloc(int(np.prod(shape)) * 4), shape)
        (self.temporaries if track else self.persistent).append(tensor)
        return tensor

    def free_temporaries(self):
        for tensor in self.temporaries:
            self.driver.free(tensor.ptr)
        self.temporaries.clear()

    def slice(self, tensor, start, shape):
        offset = int(start) * 4
        return Tensor(ctypes.c_void_p(tensor.ptr.value + offset), shape)

    def linear(self, x, weight_name, bias_name, rows, outputs):
        weight = self.weights[weight_name]
        bias = self.weights.get(bias_name)
        out = self.alloc((rows, outputs))
        self.driver.launch(self.function('gemm', 'whisper_linear_f32_tiled'),
                           (math.ceil(outputs / 64), math.ceil(rows / 64), 1), (256, 1, 1),
                           [x.ptr, weight.ptr, bias.ptr if bias else ctypes.c_void_p(None), out.ptr,
                            ctypes.c_int(rows), ctypes.c_int(outputs), ctypes.c_int(weight.shape[1])])
        return out

    def layer_norm(self, x, weight_name, bias_name):
        rows, cols = x.shape
        out = self.alloc(x.shape)
        self.driver.launch(self.function('layer_norm', 'whisper_layer_norm_f32'),
                           (rows, 1, 1), (256, 1, 1),
                           [x.ptr, self.weights[weight_name].ptr, self.weights[bias_name].ptr, out.ptr,
                            ctypes.c_int(rows), ctypes.c_int(cols), ctypes.c_float(1e-5)])
        return out

    def gelu_(self, x):
        count = x.elements
        self.driver.launch(self.function('gelu', 'whisper_gelu_f32'),
                           (math.ceil(count / 256), 1, 1), (256, 1, 1), [x.ptr, ctypes.c_int(count)])

    def add_(self, x, y):
        self.driver.launch(self.function('elementwise', 'whisper_add_f32'),
                           (math.ceil(x.elements / 256), 1, 1), (256, 1, 1),
                           [x.ptr, y.ptr, ctypes.c_int(x.elements)])

    def transpose(self, x, shape):
        out = self.alloc(shape)
        rows, cols = x.shape
        self.driver.launch(self.function('elementwise', 'whisper_transpose_2d_f32'),
                           (math.ceil(x.elements / 256), 1, 1), (256, 1, 1),
                           [x.ptr, out.ptr, ctypes.c_int(rows), ctypes.c_int(cols)])
        return out

    def to_heads(self, x, heads, dimension):
        length = x.shape[0]
        out = self.alloc((heads, length, dimension))
        self.driver.launch(self.function('elementwise', 'whisper_transpose_heads_f32'),
                           (math.ceil(x.elements / 256), 1, 1), (256, 1, 1),
                           [x.ptr, out.ptr, ctypes.c_int(length), ctypes.c_int(heads), ctypes.c_int(dimension)])
        return out

    def from_heads(self, x, length, heads, dimension):
        out = self.alloc((length, heads * dimension))
        self.driver.launch(self.function('elementwise', 'whisper_merge_heads_f32'),
                           (math.ceil(out.elements / 256), 1, 1), (256, 1, 1),
                           [x.ptr, out.ptr, ctypes.c_int(length), ctypes.c_int(heads), ctypes.c_int(dimension)])
        return out

    def attention(self, q, k, v, causal):
        heads, query_length, dimension = q.shape
        key_length = k.shape[1]
        out = self.alloc((heads, query_length, dimension))
        self.driver.launch(self.function('attention', 'whisper_attention_f32'),
                           (heads, query_length, 1), (128, 1, 1),
                           [q.ptr, k.ptr, v.ptr, out.ptr, ctypes.c_int(query_length), ctypes.c_int(key_length),
                            ctypes.c_int(heads), ctypes.c_int(dimension), ctypes.c_int(causal),
                            ctypes.c_float(1.0 / math.sqrt(dimension))],
                           shared=key_length * 4)
        return out

    def conv1d(self, x, weight_name, bias_name, out_length, stride, padding):
        weight = self.weights[weight_name]
        bias = self.weights[bias_name]
        in_channels, length = x.shape
        out_channels = weight.shape[0]
        out = self.alloc((out_channels, out_length))
        total = out_channels * out_length
        self.driver.launch(self.function('simple', 'whisper_conv1d_k3_f32_simple'),
                           (math.ceil(total / 256), 1, 1), (256, 1, 1),
                           [x.ptr, weight.ptr, bias.ptr, out.ptr, ctypes.c_int(length), ctypes.c_int(out_length),
                            ctypes.c_int(in_channels), ctypes.c_int(out_channels), ctypes.c_int(stride),
                            ctypes.c_int(padding)])
        return out

    def self_attention(self, x, prefix, heads, dimension, causal):
        length = x.shape[0]
        q = self.linear(x, prefix + 'q_proj.weight', prefix + 'q_proj.bias', length, self.config['d_model'])
        k = self.linear(x, prefix + 'k_proj.weight', prefix + 'k_proj.bias', length, self.config['d_model'])
        v = self.linear(x, prefix + 'v_proj.weight', prefix + 'v_proj.bias', length, self.config['d_model'])
        context = self.attention(self.to_heads(q, heads, dimension), self.to_heads(k, heads, dimension),
                                 self.to_heads(v, heads, dimension), causal)
        merged = self.from_heads(context, length, heads, dimension)
        return self.linear(merged, prefix + 'out_proj.weight', prefix + 'out_proj.bias', length, self.config['d_model'])

    def mlp(self, x, prefix, rows):
        hidden = self.linear(x, prefix + 'fc1.weight', prefix + 'fc1.bias', rows, self.config['encoder_ffn_dim'])
        self.gelu_(hidden)
        return self.linear(hidden, prefix + 'fc2.weight', prefix + 'fc2.bias', rows, self.config['d_model'])

    def encode(self, mel):
        frames = mel.shape[1]
        x = self.conv1d(mel, 'model.encoder.conv1.weight', 'model.encoder.conv1.bias', frames, 1, 1)
        self.gelu_(x)
        out_length = (frames + 2 - 3) // 2 + 1
        x = self.conv1d(x, 'model.encoder.conv2.weight', 'model.encoder.conv2.bias', out_length, 2, 1)
        self.gelu_(x)
        x = self.transpose(x, (out_length, self.config['d_model']))
        self.add_(x, self.weights['model.encoder.embed_positions.weight'])
        heads = self.config['encoder_attention_heads']
        dimension = self.config['d_model'] // heads
        for index in range(self.config['encoder_layers']):
            prefix = f'model.encoder.layers.{index}.'
            norm = self.layer_norm(x, prefix + 'self_attn_layer_norm.weight', prefix + 'self_attn_layer_norm.bias')
            self.add_(x, self.self_attention(norm, prefix + 'self_attn.', heads, dimension, 0))
            norm = self.layer_norm(x, prefix + 'final_layer_norm.weight', prefix + 'final_layer_norm.bias')
            self.add_(x, self.mlp(norm, prefix, out_length))
        return self.layer_norm(x, 'model.encoder.layer_norm.weight', 'model.encoder.layer_norm.bias')

    def cross_cache(self, encoder):
        length = encoder.shape[0]
        heads = self.config['decoder_attention_heads']
        dimension = self.config['d_model'] // heads
        cache = []
        for index in range(self.config['decoder_layers']):
            prefix = f'model.decoder.layers.{index}.encoder_attn.'
            k = self.linear(encoder, prefix + 'k_proj.weight', prefix + 'k_proj.bias', length, self.config['d_model'])
            v = self.linear(encoder, prefix + 'v_proj.weight', prefix + 'v_proj.bias', length, self.config['d_model'])
            cache.append((self.to_heads(k, heads, dimension), self.to_heads(v, heads, dimension)))
        return cache, heads, dimension

    def embed(self, tokens, device_tokens):
        count = len(tokens)
        out = self.alloc((count, self.config['d_model']))
        self.driver.launch(self.function('elementwise', 'whisper_embedding_f32'),
                           (math.ceil(out.elements / 256), 1, 1), (256, 1, 1),
                           [device_tokens.ptr, self.weights['model.decoder.embed_tokens.weight'].ptr, out.ptr,
                            ctypes.c_int(count), ctypes.c_int(self.config['d_model'])])
        positions = self.slice(self.weights['model.decoder.embed_positions.weight'], 0, (count, self.config['d_model']))
        self.add_(out, positions)
        return out

    def decoder_logits(self, tokens, cross, heads, dimension):
        device_tokens = self.alloc((len(tokens),), track=True)
        token_array = np.asarray(tokens, dtype=np.int32)
        self.driver.h2d(device_tokens.ptr, token_array.tobytes())
        x = self.embed(tokens, device_tokens)
        count = len(tokens)
        for index in range(self.config['decoder_layers']):
            prefix = f'model.decoder.layers.{index}.'
            norm = self.layer_norm(x, prefix + 'self_attn_layer_norm.weight', prefix + 'self_attn_layer_norm.bias')
            self.add_(x, self.self_attention(norm, prefix + 'self_attn.', heads, dimension, 1))
            norm = self.layer_norm(x, prefix + 'encoder_attn_layer_norm.weight', prefix + 'encoder_attn_layer_norm.bias')
            q = self.linear(norm, prefix + 'encoder_attn.q_proj.weight', prefix + 'encoder_attn.q_proj.bias',
                            count, self.config['d_model'])
            k, v = cross[index]
            context = self.attention(self.to_heads(q, heads, dimension), k, v, 0)
            merged = self.from_heads(context, count, heads, dimension)
            self.add_(x, self.linear(merged, prefix + 'encoder_attn.out_proj.weight',
                                     prefix + 'encoder_attn.out_proj.bias', count, self.config['d_model']))
            norm = self.layer_norm(x, prefix + 'final_layer_norm.weight', prefix + 'final_layer_norm.bias')
            self.add_(x, self.mlp(norm, prefix, count))
        norm = self.layer_norm(x, 'model.decoder.layer_norm.weight', 'model.decoder.layer_norm.bias')
        last = self.slice(norm, (count - 1) * self.config['d_model'], (1, self.config['d_model']))
        logits = self.linear(last, 'model.decoder.embed_tokens.weight', None, 1, self.config['vocab_size'])
        values = self.driver.d2h(logits.ptr, self.config['vocab_size'] * 4)
        return np.frombuffer(values, dtype=np.float32).copy()

    def detect_language(self, cross, heads, dimension, tokenizer):
        start = tokenizer.token_to_id('<|startoftranscript|>')
        logits = self.decoder_logits([start], cross, heads, dimension)
        english = tokenizer.token_to_id('<|en|>')
        chinese = tokenizer.token_to_id('<|zh|>')
        if english is None or chinese is None:
            return 'en'
        return 'zh' if logits[chinese] >= logits[english] else 'en'

    def transcribe(self, mel, language, max_tokens=80):
        from tokenizers import Tokenizer
        tokenizer = Tokenizer.from_file(str(self.model_dir / 'tokenizer.json'))
        encoder = self.encode(mel)
        cross, heads, dimension = self.cross_cache(encoder)
        if language not in ('zh', 'en'):
            language = self.detect_language(cross, heads, dimension, tokenizer)
        language_id = tokenizer.token_to_id(f'<|{language}|>')
        start = tokenizer.token_to_id('<|startoftranscript|>')
        transcribe = tokenizer.token_to_id('<|transcribe|>')
        no_timestamps = tokenizer.token_to_id('<|notimestamps|>')
        if None in (language_id, start, transcribe, no_timestamps):
            raise ValueError('Tokenizer is missing Whisper special tokens')
        tokens = [start, language_id, transcribe, no_timestamps]
        begin_suppress = self.generation.get('begin_suppress_tokens') or []
        suppress = self.generation.get('suppress_tokens') or []
        if isinstance(begin_suppress, int):
            begin_suppress = [begin_suppress]
        if isinstance(suppress, int):
            suppress = [suppress]
        for _ in range(max_tokens):
            logits = self.decoder_logits(tokens, cross, heads, dimension)
            for token in suppress:
                if 0 <= token < logits.size:
                    logits[token] = -np.inf
            if len(tokens) == 4:
                for token in begin_suppress:
                    if 0 <= token < logits.size:
                        logits[token] = -np.inf
            logits[TIMESTAMP_BEGIN:] = -np.inf
            next_token = int(np.argmax(logits))
            if next_token == EOS:
                break
            tokens.append(next_token)
        text = tokenizer.decode(tokens[4:], skip_special_tokens=True).strip()
        return text, tokens, encoder, language


    def transcribe_pcm(self, pcm, language, max_tokens=80):
        audio = np.asarray(pcm, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        features = mel_frontend.log_mel(audio)
        tensor = self.alloc(features.shape, track=True)
        self.driver.h2d(tensor.ptr, np.ascontiguousarray(features).tobytes())
        return self.transcribe(tensor, language, max_tokens)

    def close(self):
        self.free_temporaries()
        for tensor in self.persistent:
            self.driver.free(tensor.ptr)
        self.persistent.clear()
        for tensor in self.weights.values():
            self.driver.free(tensor.ptr)
        self.weights.clear()
        self.driver.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--features', default=None)
    parser.add_argument('--wav', default=None)
    parser.add_argument('--language', default='en')
    parser.add_argument('--max-tokens', type=int, default=80)
    parser.add_argument('--dump-encoder', default=None)
    args = parser.parse_args()

    if bool(args.features) == bool(args.wav):
        parser.error('Provide exactly one of --features or --wav')

    engine = WhisperEngine(args.model)
    if args.wav:
        features = mel_frontend.from_wav(args.wav)
    else:
        features = np.load(args.features)
        if features.ndim == 3:
            features = features[0]
    features = np.ascontiguousarray(features, dtype=np.float32)
    mel = engine.alloc(features.shape, track=False)
    engine.driver.h2d(mel.ptr, features.tobytes())
    started = time.perf_counter()
    text, tokens, encoder, used = engine.transcribe(mel, args.language, args.max_tokens)
    elapsed = (time.perf_counter() - started) * 1000
    if args.dump_encoder:
        values = engine.driver.d2h(encoder.ptr, encoder.elements * 4)
        np.save(args.dump_encoder, np.frombuffer(values, dtype=np.float32).reshape(encoder.shape))
    print(json.dumps({'text': text, 'language': used, 'tokens': tokens, 'ms': round(elapsed, 1)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
