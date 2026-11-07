"""Encode private 16kHz Float32 tracks to bounded, playable MP3 parts."""
import argparse
import json
from fractions import Fraction
from pathlib import Path
import uuid
import av
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--directory', required=True)
args = parser.parse_args()
directory = Path(args.directory)
if not directory.is_absolute() or directory.is_symlink():
    raise SystemExit('Invalid recording directory')
uuid.UUID(directory.name)
tracks = []
for source in ['microphone', 'system_audio']:
    file = directory / (source + '.pcm')
    if file.exists():
        if file.is_symlink() or file.stat().st_size % 4:
            raise SystemExit('Invalid recording track')
        if file.stat().st_size:
            tracks.append(np.memmap(file, dtype='<f4', mode='r'))
if not tracks:
    raise SystemExit('Empty recording')
rate = 16000
length = max(len(track) for track in tracks)
part_samples = rate * 8 * 60
result = []
for number, start in enumerate(range(0, length, part_samples), 1):
    end = min(length, start + part_samples)
    filename = 'audio-%03d.mp3' % number
    file = directory / filename
    if file.is_symlink():
        raise SystemExit('Invalid output')
    temporary = directory / (filename + '.partial')
    if temporary.is_symlink():
        raise SystemExit('Invalid temporary output')
    with av.open(str(temporary), mode='w', format='mp3') as output:
        stream = output.add_stream('libmp3lame', rate=rate)
        stream.layout = 'mono'
        stream.bit_rate = 48000
        stream.codec_context.format = 'fltp'
        for at in range(start, end, rate):
            stop = min(end, at + rate)
            samples = np.zeros(stop - at, dtype=np.float32)
            for track in tracks:
                if at < len(track):
                    part = track[at:min(stop, len(track))]
                    samples[:len(part)] += part / len(tracks)
            if not np.isfinite(samples).all():
                raise RuntimeError('Invalid recording samples')
            np.clip(samples, -1, 1, out=samples)
            frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format='fltp', layout='mono')
            frame.sample_rate = rate
            frame.time_base = Fraction(1, rate)
            frame.pts = at - start
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    if temporary.stat().st_size > 4 * 1024**2:
        raise RuntimeError('Encoded recording exceeds part limit')
    temporary.replace(file)
    result.append({'filename': filename, 'samples': end - start, 'bytes': file.stat().st_size})
print(json.dumps({'parts': result, 'sampleRate': rate, 'samples': length}), flush=True)
