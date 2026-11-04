"""Varied-length soak for the self-developed Whisper engine."""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
print(HERE)
from engine import WhisperEngine
import mel

REPO = HERE.parents[2]
MODEL = REPO / '.notion-switch/speech/whisper-large-v3-turbo-hf'
CLIPS = sorted((REPO / 'research/speech-fixtures/soak').glob('*.wav'))
LOG = REPO / '.notion-switch/custom-engine-soak.log'
MINUTES = float(os.environ.get('SOAK_MINUTES', '12'))


def log(line):
    text = f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {line}'
    print(text, flush=True)
    with open(LOG, 'a', encoding='utf-8') as handle:
        handle.write(text + '\n')


def main():
    engine = WhisperEngine(MODEL)
    started = time.perf_counter()
    cycles = 0
    failures = 0
    log(f'start clips={len(CLIPS)} minutes={MINUTES}')
    while time.perf_counter() - started < MINUTES * 60:
        for clip in CLIPS:
            if time.perf_counter() - started >= MINUTES * 60:
                break
            at = time.perf_counter()
            try:
                text, tokens, encoder, language = engine.transcribe_pcm(mel.read_wav(clip), 'auto')
                log(f'cycle={cycles + 1} clip={clip.name} ms={(time.perf_counter() - at) * 1000:.0f} '
                    f'language={language} text={json.dumps(text, ensure_ascii=False)}')
            except Exception as error:
                failures += 1
                log(f'cycle={cycles + 1} clip={clip.name} FAIL ms={(time.perf_counter() - at) * 1000:.0f} error={error}')
                engine.close()
                raise
            finally:
                engine.free_temporaries()
            cycles += 1
    log(f'SUMMARY cycles={cycles} failures={failures} elapsed_s={time.perf_counter() - started:.0f}')
    engine.close()


if __name__ == '__main__':
    main()
