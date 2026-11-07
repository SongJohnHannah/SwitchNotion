"""
逐字稿生成器 — 核心逻辑：模型管理、转写、状态持久化
"""

import json
import hashlib
import time
import threading
from pathlib import Path
from gpu_operator import OperatorBridge, OperatorCancelled, OperatorError

# ─── 配置 ───

WHISPER_MODEL = "large-v3-turbo"
AVAILABLE_MODELS = [WHISPER_MODEL]
VIDEO_EXTENSIONS = {
    '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv',
}
AUDIO_EXTENSIONS = {
    '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma',
}
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
PORT = 3066
STATE_FILE = Path(__file__).parent / 'transcriber_state.json'
CHUNK_SECONDS = 30  # 由统一算子控制，UI 不再覆盖已验收策略
TARGET_INSTANCES = 1
TRANSCRIBE_MODES = {'stable': {'label': 'Turbo 稳定 GPU', 'beam_size': 1}}

# ─── 全局状态 ───

state = {
    'video_dir': r'D:\迅雷下载',
    'output_dir': r'D:\迅雷下载',
    'transcribing': False,
    'cancel_requested': False,
    'current_video': '',
    'current_index': 0,
    'total': 0,
    'queue': [],
    'done': [],
    'errors': [],
    'overwrite': False,
    'transcribe_mode': 'stable',
    'add_ipa': False,
    'chunk_mode': 'operator',
    'manual_chunk_seconds': 5,
    'start_time': 0,
    'elapsed_per_video': [],
    'chunk_current': 0,
    'chunk_total': 0,
    'chunk_seconds': 0,
    'chunk_policy': '',
    'phase': '',  # extracting / transcribing
    'model_instances': 0,
    'model_info': 'large-v3-turbo · Native30 · CUDA FP16',
    'language': 'auto',
    'operator_outputs': {},
    'operator_output_directory': '',
    'operator_description': None,
    'operator_ready': False,
    'last_operator_result': None,
}

# 启动、恢复、取消与 worker 收尾共用锁，避免旧任务退出时覆盖新任务。
task_lock = threading.RLock()
_worker_lock = threading.Lock()


class TranscriptionCancelled(Exception):
    """在安全的分块边界停止，保留已完成分块。"""


def _check_cancelled():
    if state['cancel_requested']:
        raise TranscriptionCancelled()

# ─── 统一独立 GPU 算子 ───

_model_ready = False  # 兼容状态接口：仅指入口资源就绪，不代表已加载/测试 GPU 模型。


def init_models():
    """只调用 describe 检查资源；不会导入旧 GPU 框架或载入模型。"""
    global _model_ready
    state['operator_ready'] = _model_ready = False
    description = OperatorBridge().describe()
    if description.get('resourcesReady') is False:
        raise OperatorError('统一 GPU 算子资源不完整')
    state['operator_description'] = description
    state['operator_ready'] = _model_ready = True
    state['model_instances'] = 0
    return 1


def switch_model(model_name: str):
    if model_name != WHISPER_MODEL:
        raise RuntimeError('当前使用统一 Turbo 稳定 GPU 方案，不能切回旧模型池')
    return init_models()


# ─── 工具函数 ───

def add_ipa_to_text(text: str) -> str:
    """给英文单词添加 IPA 音标，并修正常见音素教学表达"""
    if not state.get('add_ipa'):
        return text
    try:
        import re
        import eng_to_ipa as ipa
    except Exception:
        return text + "\n\n[提示] 英文音标功能需要安装 eng_to_ipa：pip install eng-to-ipa"

    # 英语课音素/自然拼读教学表达：只匹配“xx音/xx发音/xx元音/xx辅音”，避免误伤普通单词
    phoneme_map = {
        # 约 44 个英语音素（含美/英差异常见写法）
        'i:': '/iː/', 'ee': '/iː/', 'ea': '/iː/ 或 /e/', 'i': '/ɪ/', 'e': '/e/', 'ae': '/æ/', 'a': '/æ/',
        'er': '/ɜː/ 或 /ər/', 'ir': '/ɜːr/', 'ur': '/ɜːr/', 'ar': '/ɑːr/', 'or': '/ɔːr/',
        'u:': '/uː/', 'oo': '/uː/ 或 /ʊ/', 'u': '/ʌ/ 或 /juː/', 'ou': '/aʊ/ 或 /əʊ/',
        'ei': '/eɪ/', 'ai': '/aɪ/', 'oy': '/ɔɪ/', 'oi': '/ɔɪ/', 'ow': '/aʊ/ 或 /əʊ/',
        'ə': '/ə/', 'schwa': '/ə/', 'ah': '/ɑː/', 'aw': '/ɔː/',
        'p': '/p/', 'b': '/b/', 't': '/t/', 'd': '/d/', 'k': '/k/', 'g': '/g/',
        'f': '/f/', 'v': '/v/', 's': '/s/', 'z': '/z/', 'th': '/θ/ 或 /ð/', 'sh': '/ʃ/', 'zh': '/ʒ/',
        'h': '/h/', 'ch': '/tʃ/', 'j': '/dʒ/', 'tr': '/tr/', 'dr': '/dr/', 'ts': '/ts/', 'dz': '/dz/',
        'm': '/m/', 'n': '/n/', 'ng': '/ŋ/', 'l': '/l/', 'r': '/r/', 'w': '/w/', 'y': '/j/',
        # 自然拼读常见字母组合
        'ck': '/k/', 'c': '/k/ 或 /s/', 'q': '/kw/', 'qu': '/kw/', 'x': '/ks/ 或 /gz/',
        'ph': '/f/', 'gh': '/f/ 或 不发音', 'wh': '/w/', 'wr': '/r/', 'kn': '/n/', 'gn': '/n/',
        'tion': '/ʃən/', 'sion': '/ʃən/ 或 /ʒən/', 'ture': '/tʃər/', 'sure': '/ʃər/ 或 /ʒər/',
        'igh': '/aɪ/', 'oa': '/əʊ/', 'ai': '/eɪ/', 'ay': '/eɪ/', 'ee': '/iː/', 'ey': '/iː/ 或 /eɪ/',
        'au': '/ɔː/', 'augh': '/ɔːf/ 或 /ɔː/', 'ough': '/oʊ/ /uː/ /ʌf/ 等',
    }
    for key, ipa_text in sorted(phoneme_map.items(), key=lambda kv: len(kv[0]), reverse=True):
        pattern = rf'\b{re.escape(key)}\s*(?:这个)?(?:音|发音|元音|辅音|组合音|字母组合)\b'
        text = re.sub(pattern, f'{key} {ipa_text}', text, flags=re.IGNORECASE)

    # th 清浊音特殊处理
    text = re.sub(r'\bth\s*(?:清音|清辅音)\b', 'th /θ/', text, flags=re.IGNORECASE)
    text = re.sub(r'\bth\s*(?:浊音|浊辅音)\b', 'th /ð/', text, flags=re.IGNORECASE)

    seen = {}

    def repl(match):
        word = match.group(0)
        key = word.lower()
        if len(word) <= 2:
            return word
        if key not in seen:
            pron = ipa.convert(key)
            if not pron or '*' in pron or pron == key:
                seen[key] = ''
            else:
                seen[key] = pron
        return f"{word} /{seen[key]}/" if seen[key] else word

    # 避免处理已经插入的 /IPA/ 片段
    parts = re.split(r'(/[^/]+/)', text)
    for i, part in enumerate(parts):
        if not (part.startswith('/') and part.endswith('/')):
            parts[i] = re.sub(r"\b[A-Za-z][A-Za-z'-]*\b", repl, part)
    return ''.join(parts)


def clean_text_join(texts: list[str]) -> str:
    """安全合并文本：只去除相邻 chunk 的明显重复，不改写内容"""
    import re
    cleaned = []
    for text in texts:
        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            continue
        if cleaned:
            prev = cleaned[-1]
            # 检查最多 30 字的边界重复：prev 结尾 == text 开头
            max_len = min(30, len(prev), len(text))
            for n in range(max_len, 5, -1):
                if prev[-n:] == text[:n]:
                    text = text[n:].lstrip()
                    break
        if text:
            cleaned.append(text)
    return '\n'.join(cleaned)


def format_ts(seconds):
    milliseconds = max(0, round(float(seconds) * 1000))
    seconds, ms = divmod(milliseconds, 1000)
    minutes, s = divmod(seconds, 60)
    h, m = divmod(minutes, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def scan_media(media_dir: str) -> list:
    mdir = Path(media_dir)
    if not mdir.exists():
        return []
    items = []
    for f in sorted(mdir.rglob('*')):
        if f.suffix.lower() in MEDIA_EXTENSIONS and f.is_file():
            txt_path = f.with_suffix('.txt')
            items.append({
                'path': str(f),
                'name': f.stem,
                'ext': f.suffix,
                'media_type': 'video' if f.suffix.lower() in VIDEO_EXTENSIONS else 'audio',
                'size_mb': round(f.stat().st_size / 1024 / 1024, 1),
                'has_txt': txt_path.exists(),
            })
    return items


def get_output_paths(video_path: str):
    src = Path(video_path)
    out_dir = Path(state['output_dir'])
    vdir = Path(state['video_dir'])
    if out_dir == vdir:
        txt_path = src.with_suffix('.txt')
        srt_path = src.with_suffix('.srt')
    else:
        try:
            rel = src.relative_to(vdir)
        except ValueError:
            rel = src.name
        txt_path = out_dir / Path(rel).with_suffix('.txt')
        srt_path = out_dir / Path(rel).with_suffix('.srt')
    return txt_path, srt_path


# ─── 转写 ───

def operator_output_path(video_path, txt_path):
    src = Path(video_path).resolve()
    identity = hashlib.sha256(str(src).encode('utf-8')).hexdigest()[:10]
    return Path(txt_path).parent / f'.gpu-operator_{src.stem}-{identity}'


def transcribe_one(video_path: str, *, language=None):
    """Queue/UI and offline callers share this one GPU-only entry point."""
    _check_cancelled()
    src = Path(video_path).resolve()
    txt_path, srt_path = get_output_paths(str(src))
    txt_path = txt_path.resolve()
    srt_path = srt_path.resolve()
    txt_path.parent.mkdir(parents=True, exist_ok=True)
    output = operator_output_path(src, txt_path)
    output.mkdir(parents=True, exist_ok=True)
    selected_language = language or state.get('language', 'auto')
    if selected_language not in ('auto', 'en', 'zh'):
        raise RuntimeError('无效的转写语言')
    state['operator_output_directory'] = str(output)
    state.setdefault('operator_outputs', {})[str(src)] = str(output)
    state['phase'] = 'preparing'
    state['chunk_current'] = state['chunk_total'] = 0
    state['chunk_seconds'] = CHUNK_SECONDS
    state['chunk_policy'] = '统一 Turbo 稳定 GPU 算子（Native30）'
    save_state()

    def progress(event):
        value = event.get('progress', event)
        if not isinstance(value, dict):
            return
        state['phase'] = value.get('phase') or 'transcribing'
        if isinstance(value.get('totalChunks'), int):
            state['chunk_total'] = value['totalChunks']
        if isinstance(value.get('index'), int):
            state['chunk_current'] = value['index'] + 1
        elif isinstance(value.get('completedChunks'), int):
            state['chunk_current'] = value['completedChunks']

    try:
        result = OperatorBridge().transcribe(src, output, language=selected_language,
                                             on_progress=progress,
                                             is_cancelled=lambda: state['cancel_requested'])
    except OperatorCancelled as error:
        raise TranscriptionCancelled(str(error)) from error
    _check_cancelled()
    # Export exactly the operator text. IPA is an explicit user-selected derivative;
    # the operator's original TXT, events and checkpoint remain untouched.
    txt_path.write_text(add_ipa_to_text(result['text']), encoding='utf-8')
    with srt_path.open('w', encoding='utf-8') as handle:
        for index, segment in enumerate(result['segments'], 1):
            handle.write(f"{index}\n{format_ts(segment['start'])} --> {format_ts(segment['end'])}\n{segment['text'].strip()}\n\n")
    returned = {**result, 'operatorOutputDirectory': str(output),
                'exportTranscriptFile': str(txt_path), 'exportSrtFile': str(srt_path)}
    (output / 'transcriber-result.json').write_text(json.dumps(returned, ensure_ascii=False, indent=2), 'utf-8')
    state['last_operator_result'] = {key: returned.get(key) for key in
        ('complete', 'device', 'model', 'plan', 'operatorOutputDirectory', 'duration', 'totalSamples', 'transcriptSha256')}
    state['phase'] = 'complete'
    state['chunk_current'] = state['chunk_total']
    save_state()
    return returned


def worker():
    # One file queue and the shared operator GPU lease prevent overlapping jobs.
    if not _worker_lock.acquire(blocking=False):
        return
    import traceback
    try:
        while True:
            with task_lock:
                if state['cancel_requested'] or not state['queue']:
                    break
                # 真正结束才出队，进程意外退出时仍能从存档恢复当前视频。
                item = state['queue'][0]
                video_path = item['path']
                state['current_video'] = video_path
                save_state()

            t0 = time.time()
            try:
                transcribe_one(video_path)
                elapsed = time.time() - t0
                with task_lock:
                    state['elapsed_per_video'].append(elapsed)
                    state['done'].append({'video': video_path, 'name': item['name'], 'status': 'ok', 'elapsed': round(elapsed, 1), 'operator_output_directory': state.get('operator_output_directory', '')})
            except TranscriptionCancelled:
                break
            except Exception as e:
                tb = traceback.format_exc()
                print(f"  ❌ 转写失败: {item['name']}\n{tb}")
                with task_lock:
                    state['errors'].append({'video': video_path, 'name': item['name'], 'error': f"{e}\n{tb[-200:]}"})

            with task_lock:
                if state['queue'] and state['queue'][0] is item:
                    state['queue'].pop(0)
                    state['current_index'] += 1
                save_state()
    finally:
        with task_lock:
            state['transcribing'] = False
            state['current_video'] = ''
            # 保留取消标记供页面显示；启动下一次任务时清除。
            try:
                if state['queue']:
                    save_state()  # cancellation retains pending files and operator checkpoints
                else:
                    STATE_FILE.unlink(missing_ok=True)
            finally:
                _worker_lock.release()


# ─── 状态持久化 ───

def save_state():
    """保存当前进度到文件"""
    data = {
        'video_dir': state['video_dir'],
        'output_dir': state['output_dir'],
        'overwrite': state['overwrite'],
        'transcribe_mode': 'stable',
        'add_ipa': state.get('add_ipa', False),
        'chunk_mode': 'operator',
        'manual_chunk_seconds': 30,
        'language': state.get('language', 'auto'),
        'operator_outputs': state.get('operator_outputs', {}),
        'queue': state['queue'],
        'done': state['done'],
        'errors': state['errors'],
        'current_index': state['current_index'],
        'total': state['total'],
    }
    STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def load_state() -> dict | None:
    """加载上次未完成的进度"""
    if not STATE_FILE.exists():
        return None
    try:
        data = json.loads(STATE_FILE.read_text(encoding='utf-8'))
        done_paths = {d['video'] for d in data.get('done', [])}
        remaining = [v for v in data.get('queue', []) if v['path'] not in done_paths]
        if not remaining:
            STATE_FILE.unlink(missing_ok=True)
            return None
        return {
            'video_dir': data.get('video_dir', ''),
            'output_dir': data.get('output_dir', ''),
            'overwrite': data.get('overwrite', False),
            'transcribe_mode': 'stable',
            'add_ipa': data.get('add_ipa', False),
            'chunk_mode': 'operator',
            'manual_chunk_seconds': 30,
            'language': data.get('language', 'auto'),
            'operator_outputs': data.get('operator_outputs', {}),
            'queue': remaining,
            'done': data.get('done', []),
            'errors': data.get('errors', []),
            'total': data.get('total', 0),
            'remaining': len(remaining),
        }
    except Exception:
        return None
