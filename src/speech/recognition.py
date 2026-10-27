"""Shared local decoding policy for meetings, configuration tests and SDK audio."""
import base64
import time
from segmentation import acoustic_chunks

def transcribe(recognizer, message):
    if recognizer is None:
        raise RuntimeError('Worker not configured')
    audio = message.get('audio')
    if not isinstance(audio, str) or len(audio) > 6 * 1024**2:
        raise RuntimeError('Invalid audio size')
    data = base64.b64decode(audio, validate=True)
    if not data or len(data) % 4 or len(data) > 16000 * 4 * 60:
        raise RuntimeError('Expected 16kHz mono Float32 LE PCM')
    language = message.get('language', 'auto')
    context = message.get('context', '')
    if language not in ['auto', 'zh', 'en'] or not isinstance(context, str) or len(context) > 400:
        raise RuntimeError('Invalid recognition language or context')
    import numpy as np
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.abs(samples).max() > 1.01:
        raise RuntimeError('Invalid PCM samples')
    if np.sqrt(np.mean(samples**2)) < .001:
        return {'text': '', 'segments': [], 'contextText': '', 'elapsedMs': 0}
    before = time.perf_counter()
    # Automatic bilingual dictation follows the audio alone. A previous
    # Chinese phrase must not bias the next English phrase (or vice versa).
    # Explicit single-language SDK requests can still supply bounded context.
    result, languages = [], set()
    reliable = ''
    for start, end in acoustic_chunks(samples):
        chunk = samples[start:end]
        if np.sqrt(np.mean(chunk**2)) < .001:
            continue
        prompt = None if language == 'auto' else ('以下是简体中文和英语的会议记录。' if language == 'zh' else '') + context[-120:]
        segments, info = recognizer.transcribe(chunk, language=None if language == 'auto' else language,
            task='transcribe', beam_size=8, best_of=5, patience=1.5,
            temperature=[0, .2, .4], condition_on_previous_text=False,
            multilingual=language == 'auto', language_detection_threshold=.8, language_detection_segments=3,
            initial_prompt=prompt or None, vad_filter=True,
            vad_parameters={'min_speech_duration_ms': 150, 'min_silence_duration_ms': 350, 'speech_pad_ms': 150})
        segments = list(segments)
        result.extend({'start': s.start + start / 16000, 'end': s.end + start / 16000, 'text': s.text} for s in segments)
        if segments:
            languages.add(info.language)
        reliable = ''.join(s.text for s in segments if s.avg_logprob >= -.8 and s.no_speech_prob < .6 and s.compression_ratio < 2.4)
        context = reliable[-120:]
    text = ''.join(s['text'] for s in result).strip()
    if len(text) > 50000:
        raise RuntimeError('Transcript too long')
    return {'text': text, 'segments': result, 'language': next(iter(languages)) if len(languages) == 1 else 'auto', 'contextText': reliable[-120:],
            'elapsedMs': round((time.perf_counter() - before) * 1000)}
