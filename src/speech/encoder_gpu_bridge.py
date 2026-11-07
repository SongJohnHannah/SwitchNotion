"""Sequential Native B1 encoders, CT2-owned GPU concat, batched GPU decoder.

No CPU encoded-data roundtrip, raw device pointers, new CUDA context or custom
math. Caller must keep this adapter alive through synchronous generate and call
close after consuming the pipeline generator. Default construction is lazy and
does not load a CUDA context; actual CUDA work remains under the operator lease.
"""
MAX_BRIDGE_BYTES = 64 * 1024 * 1024


def cub_bin_bytes(value):
    size = 64
    while size < value and size < 16 * 1024 * 1024:
        size *= 4
    return max(size, value)


class EncoderGpuBridge:
    def __init__(self, recognizer, decoder_batch_size, gpuops=None, max_bytes=MAX_BRIDGE_BYTES):
        if type(decoder_batch_size) is not int or decoder_batch_size not in (2, 4):
            raise RuntimeError('GPU encoder bridge requires decoder batch 2 or 4')
        if type(max_bytes) is not int or not 0 < max_bytes <= MAX_BRIDGE_BYTES:
            raise RuntimeError('GPU encoder bridge memory cap must be at most 64MiB')
        if getattr(recognizer.model, 'device', None) != 'cuda':
            raise RuntimeError('GPU encoder bridge requires an existing CUDA model')
        indices = list(getattr(recognizer.model, 'device_index', []))
        if len(indices) != 1 or type(indices[0]) is not int or indices[0] < 0:
            raise RuntimeError('GPU encoder bridge requires one existing CUDA device')
        self._recognizer = recognizer
        self._batch_size = decoder_batch_size
        self._device_index = indices[0]
        self._gpuops = gpuops
        self._max_bytes = max_bytes
        self._held_outputs = []
        self._last_output = None
        self._history = []

    def __getattr__(self, name):
        return getattr(self._recognizer, name)

    def close(self):
        # CT2 owns all allocations. This only drops strong Python references;
        # no external pointer free or context reset can race another worker.
        self._last_output = None
        self._held_outputs = []

    def encode(self, features):
        import numpy as np
        values = np.asarray(features)
        if values.ndim == 2:
            values = np.expand_dims(values, 0)
        if values.ndim != 3 or not 1 <= len(values) <= self._batch_size or not 1 <= values.shape[2] <= 3000:
            raise RuntimeError('GPU encoder bridge expects 1..requested batch mel rows of at most 3000 frames')
        if not np.isfinite(values).all():
            raise RuntimeError('GPU encoder bridge features must be finite')
        input_mels = int(getattr(self._recognizer.model, 'n_mels', values.shape[1]))
        if values.shape[1] != input_mels:
            raise RuntimeError('GPU encoder bridge mel dimension differs from the model')
        if self._gpuops is None:
            import _ct2_gpuops
            self._gpuops = _ct2_gpuops
        self.close()  # Prior synchronous pipeline forward/generate has finished.
        observations = []
        try:
            for index in range(len(values)):
                part = np.ascontiguousarray(values[index:index + 1])
                # Reuse exactly the validated faster-whisper B1 encode path;
                # on a single GPU it calls core.encode(...,to_cpu=False).
                encoded = self._recognizer.encode(part)
                shape = list(getattr(encoded, 'shape', []))
                if (getattr(encoded, 'device', None) != 'cuda' or
                        getattr(encoded, 'device_index', None) != self._device_index or
                        len(shape) != 3 or shape[0] != 1 or shape[1] != (values.shape[2] + 1) // 2 or
                        shape[1] == input_mels or shape[1] > 1500 or shape[2] != 1280):
                    raise RuntimeError('GPU encoder returned invalid preencoded CUDA shape/device')
                interface = encoded.__cuda_array_interface__
                if (interface.get('typestr') != '<f2' or interface.get('strides') is not None or
                        list(interface.get('shape', [])) != shape):
                    raise RuntimeError('GPU encoder bridge requires contiguous FP16 encoded storage')
                item_bytes = int(np.prod(shape, dtype=np.int64)) * 2
                peak_bytes = cub_bin_bytes(item_bytes) * len(values) + 2 * cub_bin_bytes(item_bytes * len(values))
                if item_bytes * len(values) * 3 > self._max_bytes or peak_bytes > self._max_bytes:
                    raise RuntimeError('GPU encoder source/concat/generate copy exceeds 64MiB bridge budget')
                if observations and shape != observations[0]['encodedShape']:
                    raise RuntimeError('GPU encoded rows must have identical shapes')
                self._held_outputs.append(encoded)
                observations.append({'inputShape': list(part.shape), 'encodedShape': shape,
                                     'deviceIndex': self._device_index, 'bytes': item_bytes})
            merged = self._gpuops.concat_axis0(self._held_outputs, max_bytes=self._max_bytes, input_mels=input_mels)
            expected = [len(values), *observations[0]['encodedShape'][1:]]
            if (getattr(merged, 'device', None) != 'cuda' or getattr(merged, 'device_index', None) != self._device_index or
                    list(getattr(merged, 'shape', [])) != expected or merged.__cuda_array_interface__.get('typestr') != '<f2'):
                raise RuntimeError('GPU concat returned invalid encoded CUDA batch')
            self._last_output = merged
            source_bytes = sum(item['bytes'] for item in observations)
            self._history.append({'encoderCalls': len(observations), 'actualEncoderBatchSizes': [1] * len(observations),
                                  'encoders': observations, 'decoderBatchSize': len(values), 'mergedShape': expected,
                                  'sourceBytes': source_bytes, 'mergedBytes': source_bytes,
                                  'generateSyncCopyBytes': source_bytes, 'logicalBridgePeakBytes': source_bytes * 3,
                                  'budgetedBridgePeakBytes': cub_bin_bytes(observations[0]['bytes']) * len(values) + 2 * cub_bin_bytes(source_bytes),
                                  'allocationBudget': 'Native CUB growth4/min3/max12 bin rounding; excludes model/decoder workspaces/cache'})
            return merged
        except Exception:
            self.close()
            raise

    def metadata(self):
        return {'requestedDecoderBatchSize': self._batch_size, 'encoderDevice': 'cuda', 'decoderDevice': 'cuda',
                'outputBridge': 'ct2-owned-gpu-concat-axis0', 'preencodedDecoderInput': True,
                'zeroCopy': False, 'generatePerformsSyncCopy': True, 'maxBridgeBytes': self._max_bytes,
                'context': {'management': 'CT2 ScopedDeviceSetter/allocator/stream',
                            'deviceIndex': self._device_index, 'additionalContextCreated': False,
                            'driverContextHandleQueried': False},
                'batches': list(self._history),
                'lifetime': 'Source views and merged output retained through synchronous generate; close after generator drain.',
                'qualityScope': 'Same B1 encoder and existing GPU concat; batched decoder control flow still requires independent quality validation.'}
