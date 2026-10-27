"""Real local MP3 checks using synthetic tones, without microphone access."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
import av
import numpy as np

PROJECT = Path(__file__).resolve().parent.parent
ENCODER = PROJECT / 'src' / 'speech' / 'encode-meeting.py'


class RecordingCodecTest(unittest.TestCase):
    def setUp(self):
        state = PROJECT / '.notion-switch'
        state.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='test-audio-codec-', dir=state)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / str(uuid.uuid4())
        self.directory.mkdir()

    def encode(self):
        value = subprocess.run([sys.executable, '-B', str(ENCODER), '--directory', str(self.directory)],
                               capture_output=True, check=True, timeout=90)
        return json.loads(value.stdout)

    def decode(self, filename):
        with av.open(str(self.directory / filename)) as audio:
            self.assertEqual(audio.streams.audio[0].sample_rate, 16000)
            return np.concatenate([frame.to_ndarray().reshape(-1) for frame in audio.decode(audio=0)])

    def test_mixed_sources_preserve_duration_tail_and_playable_audio(self):
        rate = 16000
        for source, frequency in [('microphone', 440), ('system_audio', 660)]:
            samples = .2 * np.sin(2 * np.pi * frequency * np.arange(rate * 3 + 777) / rate)
            samples.astype('<f4').tofile(self.directory / (source + '.pcm'))
        result = self.encode()
        self.assertEqual(result['samples'], rate * 3 + 777)
        self.assertEqual(len(result['parts']), 1)
        decoded = self.decode(result['parts'][0]['filename'])
        self.assertLess(abs(len(decoded) - result['samples']), rate // 20)
        self.assertGreater(float(np.sqrt(np.mean(decoded[-500:] ** 2))), .04)
        self.assertLess(result['parts'][0]['bytes'], 4 * 1024**2)

    def test_eight_minute_parts_include_final_two_seconds(self):
        samples = np.zeros(16000 * (8 * 60 + 2), dtype='<f4')
        samples[-32000:] = .2 * np.sin(2 * np.pi * 440 * np.arange(32000) / 16000)
        samples.tofile(self.directory / 'microphone.pcm')
        result = self.encode()
        self.assertEqual([part['samples'] for part in result['parts']], [16000 * 480, 32000])
        self.assertTrue(all(part['bytes'] <= 4 * 1024**2 for part in result['parts']))
        tail = self.decode(result['parts'][-1]['filename'])
        self.assertLess(abs(len(tail) - 32000), 800)
        self.assertGreater(float(np.sqrt(np.mean(tail[-500:] ** 2))), .08)


if __name__ == '__main__':
    unittest.main()
