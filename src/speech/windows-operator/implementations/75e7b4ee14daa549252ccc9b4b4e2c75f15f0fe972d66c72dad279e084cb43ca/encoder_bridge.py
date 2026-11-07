"""Opt-in CUDA encoder microbatches, bridged through CPU storage to CUDA decode."""


class EncoderMicrobatchBridge:
    def __init__(self, recognizer, microbatch_size, storage_view_factory=None):
        if type(microbatch_size) is not int or microbatch_size not in (1, 2):
            raise RuntimeError('Encoder microbatch size must be 1 or 2')
        if getattr(recognizer.model, 'device', None) != 'cuda':
            raise RuntimeError('Encoder bridge requires an existing CUDA model')
        if storage_view_factory is None:
            from ctranslate2 import StorageView
            storage_view_factory = StorageView.from_array
        self._recognizer = recognizer
        self._size = microbatch_size
        self._view = storage_view_factory
        self._last_output = None
        self._encoder_batches = []
        self._decoder_batches = []
        self._encoded_shapes = []

    def __getattr__(self, name):
        return getattr(self._recognizer, name)

    def encode(self, features):
        import numpy as np
        values = np.asarray(features)
        if values.ndim == 2:
            values = np.expand_dims(values, 0)
        if values.ndim != 3 or values.shape[0] < 1:
            raise RuntimeError('Expected a nonempty batched mel feature tensor')
        outputs = []
        for at in range(0, len(values), self._size):
            part = np.ascontiguousarray(values[at:at + self._size])
            # The same CUDA model performs the neural encoder. to_cpu only
            # copies its completed output, as documented by CTranslate2.
            encoded = self._recognizer.model.encode(self._view(part), to_cpu=True)
            if getattr(encoded, 'device', None) != 'cpu':
                raise RuntimeError('CUDA encoder did not return the requested CPU storage')
            array = np.array(encoded, copy=True, order='C')
            if array.ndim != 3 or array.shape[0] != len(part) or array.shape[1] != (values.shape[2] + 1) // 2:
                raise RuntimeError('Unexpected encoded feature batch shape')
            if array.shape[1] == values.shape[1]:
                raise RuntimeError('Encoded shape could be mistaken for uncoded mel features')
            if outputs and (array.shape[1:] != outputs[0].shape[1:] or array.dtype != outputs[0].dtype):
                raise RuntimeError('Encoder microbatches have incompatible shapes or data types')
            outputs.append(array)
            self._encoder_batches.append(len(part))
            self._encoded_shapes.append(list(array.shape))
        merged = np.ascontiguousarray(np.concatenate(outputs, axis=0))
        if len(merged) != len(values):
            raise RuntimeError('Encoder bridge lost a batch item')
        self._decoder_batches.append(len(merged))
        self._last_output = merged  # Keep the shared CPU buffer alive through generate.
        # generate() accepts pre-encoded features and transfers this storage to
        # CUDA. Its maybe_encode() recognizes the shape and does not re-encode.
        return self._view(merged)

    def metadata(self):
        return {'requestedMicrobatchSize': self._size, 'encoderDevice': 'cuda', 'decoderDevice': 'cuda',
                'outputBridge': 'cpu', 'preencodedDecoderInput': True,
                'actualEncoderBatchSizes': list(self._encoder_batches),
                'decoderInputBatchSizes': list(self._decoder_batches),
                'encodedOutputShapes': list(self._encoded_shapes),
                'math': 'Same CUDA model encoder and generator; CPU only copies and concatenates encoded results'}
