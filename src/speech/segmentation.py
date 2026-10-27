"""The batch equivalent of the streaming, sample-preserving pause detector."""
import json
from pathlib import Path
import numpy as np

POLICY = json.loads(Path(__file__).with_name('segmentation.json').read_text())


def acoustic_chunks(samples):
    window = POLICY['windowSamples']
    start = silence = 0
    for at in range(0, len(samples) - window + 1, window):
        end = at + window
        rms = np.sqrt(np.mean(samples[at:end].astype(np.float64)**2))
        silence = silence + window if rms < POLICY['silenceRms'] else 0
        if end - start >= POLICY['maximumSamples'] or (end - start >= POLICY['minimumSamples'] and silence >= POLICY['pauseSamples']):
            yield start, end
            start, silence = end, 0
    if start < len(samples):
        yield start, len(samples)
