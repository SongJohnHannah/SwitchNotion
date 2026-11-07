"""
逐字稿生成器 — 核心逻辑：模型管理、转写、状态持久化
"""

import json
import shutil
import subprocess
import time
import threading
import queue as _queue_mod
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── 配置 ───

WHISPER_MODEL = "large-v3"
AVAILABLE_MODELS = ["medium", "large-v3"]
VIDEO_EXTENSIONS = {
    '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv',
}
AUDIO_EXTENSIONS = {
    '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma',
}
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
PORT = 3066
STATE_FILE = Path(__file__).parent / 'transcriber_state.json'
CHUNK_SECONDS = 600  # 每段10分钟
LONG_CHUNK_SECONDS = 900  # 短视频用更长切片
SHORT_VIDEO_THRESHOLD = 1800  # 30分钟以下算短视频
TARGET_INSTANCES = 2  # 实测（60 分钟音频/6 块）：1 实例 28.7x / 6.84GB，2 实例 32.6x / 12.54GB，2 实例快 13.5%
BATCH_SIZE = 8  # 与 16 同速但显存/带宽占用更低。注意崩溃时机随机（1~8 次推理调用之间），与批大小无关，调参消不掉
TRANSCRIBE_MODES = {
    'fast': {'label': '快速', 'beam_size': 1},
    'standard': {'label': '标准', 'beam_size': 3},
    'accurate': {'label': '高精度', 'beam_size': 5},
}

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
    'transcribe_mode': 'standard',
    'add_ipa': False,
    'chunk_mode': 'auto',
    'manual_chunk_seconds': 5,
    'start_time': 0,
    'elapsed_per_video': [],
    'chunk_current': 0,
    'chunk_total': 0,
    'chunk_seconds': 0,
    'chunk_policy': '',
    'phase': '',  # extracting / transcribing
    'model_instances': 0,
    'model_info': '',
}

# 启动、恢复、取消与 worker 收尾共用锁，避免旧任务退出时覆盖新任务。
task_lock = threading.RLock()
_worker_lock = threading.Lock()


class TranscriptionCancelled(Exception):
    """在安全的分块边界停止，保留已完成分块。"""


def _check_cancelled():
    if state['cancel_requested']:
        raise TranscriptionCancelled()

# ─── 模型池 ───

_model_pool = []
_model_queue = _queue_mod.Queue()
_model_ready = False
_load_generation = 0  # 递增编号，用于取消过时的加载


def init_models():
    """加载多个模型实例，每个包装为批处理推理管线"""
    global _model_ready, _load_generation
    my_gen = _load_generation
    from faster_whisper import WhisperModel, BatchedInferencePipeline
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    target = 1 if device == "cpu" else TARGET_INSTANCES

    if device == "cuda":
        # 先建立 torch 的 CUDA 上下文，让 cuBLAS/cuDNN 由 torch 统一加载，
        # 避免 ctranslate2 自行加载时与 torch 的 cuDNN 子 DLL 版本冲突
        torch.zeros(1, device="cuda")
        torch.cuda.synchronize()

    print(f"  加载 faster-whisper ({WHISPER_MODEL}, {device}, {compute_type}, batch={BATCH_SIZE}), 目标 {target} 实例")

    loaded = 0
    for i in range(target):
        if _load_generation != my_gen:
            print(f"  ⏹ 加载被新请求中断")
            break
        try:
            # 串行加载：先用 CPU 加载到 RAM，转到 GPU 后再加载下一个
            # 避免两个模型同时展开到 RAM 导致 mkl_malloc OOM
            m = WhisperModel(WHISPER_MODEL, device=device, compute_type=compute_type)
            if _load_generation != my_gen:
                print(f"  ⏹ 加载被新请求中断")
                break
            # 加载成功后立刻清理 CPU 缓存，释放 RAM 给下一个实例
            import gc; gc.collect()
            pipe = BatchedInferencePipeline(m)
            _model_pool.append(pipe)
            _model_queue.put(pipe)
            loaded += 1
            print(f"  ✅ 实例 {loaded}/{target} 就绪")
        except Exception as e:
            print(f"  ⚠️ 实例 {loaded+1} 加载失败: {e}")
            break

    _model_ready = True
    state['model_instances'] = loaded
    state['model_info'] = f"{WHISPER_MODEL} × {loaded} (batch={BATCH_SIZE})"
    return loaded


def switch_model(model_name: str):
    """清空模型池并加载新模型"""
    global WHISPER_MODEL, _model_pool, _model_queue, _model_ready, _load_generation
    _load_generation += 1  # 使正在进行的旧加载失效
    _model_pool.clear()
    # 清空队列
    while not _model_queue.empty():
        try:
            _model_queue.get_nowait()
        except Exception:
            break
    _model_ready = False
    WHISPER_MODEL = model_name
    import gc, torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
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
    seconds = float(seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
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


def choose_chunk_seconds(duration: float) -> tuple[int, str]:
    """根据视频时长选择切片大小（16GB 显存下切片不再受显存约束）"""
    if duration > 0 and duration <= SHORT_VIDEO_THRESHOLD:
        return LONG_CHUNK_SECONDS, f'短视频，{LONG_CHUNK_SECONDS // 60}分钟切片'
    return CHUNK_SECONDS, f'{CHUNK_SECONDS // 60}分钟切片'


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

def _do_transcribe(m, chunk_path, chunk_index, chunk_seconds):
    """核心转写逻辑：VAD 过滤 + 批处理并行解码"""
    offset = chunk_index * chunk_seconds
    mode = TRANSCRIBE_MODES.get(state.get('transcribe_mode', 'standard'), TRANSCRIBE_MODES['standard'])
    segments_iter, info = m.transcribe(
        str(chunk_path),
        language=None,
        beam_size=mode['beam_size'],
        vad_filter=True,
        batch_size=BATCH_SIZE,
        # BatchedInferencePipeline 默认丢弃时间轴，字幕需要显式开启
        without_timestamps=False,
    )
    segs = []
    texts = []
    for seg in segments_iter:
        segs.append({
            'start': seg.start + offset,
            'end': seg.end + offset,
            'text': seg.text.strip(),
        })
        texts.append(seg.text.strip())
    return segs, texts


def transcribe_chunk(chunk_path, chunk_index, chunk_seconds):
    """转写单个 chunk"""
    _check_cancelled()
    m = _model_queue.get()
    try:
        _check_cancelled()
        segs, texts = _do_transcribe(m, chunk_path, chunk_index, chunk_seconds)
    finally:
        _model_queue.put(m)
    return chunk_index, segs, ' '.join(texts)


def transcribe_one(video_path: str):
    """分块并行转写，支持单视频内断点续传"""
    _check_cancelled()
    src = Path(video_path)
    txt_path, srt_path = get_output_paths(video_path)
    txt_path.parent.mkdir(parents=True, exist_ok=True)

    chunk_dir = txt_path.parent / f'.chunks_{src.stem}'
    progress_file = chunk_dir / '_progress.json'

    # 检查是否有未完成的分块进度
    if progress_file.exists():
        completed = set(int(x) for x in json.loads(progress_file.read_text('utf-8')).get('done', []))
    else:
        completed = set()

    # 根据视频时长和当前模型/显存选 chunk 大小；断点续传沿用原设置，避免时间轴错位
    probe = subprocess.run([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(src),
    ], capture_output=True, text=True)
    try:
        duration = float(probe.stdout.strip())
    except (ValueError, AttributeError):
        duration = 0

    if progress_file.exists():
        progress_data = json.loads(progress_file.read_text('utf-8'))
        chunk_seconds = int(progress_data.get('chunk_seconds') or CHUNK_SECONDS)
        chunk_policy = progress_data.get('chunk_policy', '沿用断点续传切片设置')
    else:
        if state.get('chunk_mode') == 'manual':
            try:
                mins = max(1, min(10, int(state.get('manual_chunk_seconds', 5))))
            except (TypeError, ValueError):
                mins = 5
            chunk_seconds = mins * 60
            chunk_policy = f'手动设置，{mins}分钟切片'
        else:
            chunk_seconds, chunk_policy = choose_chunk_seconds(duration)

    state['chunk_seconds'] = chunk_seconds
    state['chunk_policy'] = chunk_policy

    # 如果没有已完成分块，先提取音频并切块（一步到位，不写中间文件）
    if not completed:
        chunk_dir.mkdir(parents=True, exist_ok=True)
        state['phase'] = 'extracting'
        state['chunk_current'] = 0
        state['chunk_total'] = 0
        save_state()

        r = subprocess.run([
            'ffmpeg', '-y', '-i', str(src),
            '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
            '-f', 'segment', '-segment_time', str(chunk_seconds),
            str(chunk_dir / '%04d.wav'),
        ], capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(f"音频提取+切块失败: ffmpeg return {r.returncode}")
        progress_file.write_text(
            json.dumps({
                'done': [],
                'chunk_seconds': chunk_seconds,
                'chunk_policy': chunk_policy,
            }, ensure_ascii=False), 'utf-8')

    chunks = sorted(
        [f for f in chunk_dir.iterdir() if f.suffix == '.wav' and f.name[:4].isdigit()],
        key=lambda f: int(f.stem)
    )

    if not chunks:
        # Fallback: 直接用原文件转写（不切块）
        _check_cancelled()
        m = _model_queue.get()
        try:
            all_segments, all_texts = _do_transcribe(m, src, 0, 0)
        finally:
            _model_queue.put(m)
        txt_path.write_text(add_ipa_to_text(clean_text_join(all_texts)), 'utf-8')
        with open(srt_path, 'w', encoding='utf-8') as f:
            for idx, seg in enumerate(all_segments, 1):
                f.write(f"{idx}\n{format_ts(seg['start'])} --> {format_ts(seg['end'])}\n{seg['text']}\n\n")
        state['chunk_current'] = 1
        state['chunk_total'] = 1
        save_state()
        return

    # chunk 结果按 index 存，最后按序合并
    chunk_results = {}
    state['phase'] = 'transcribing'
    save_state()

    # 加载已完成的段
    for i in completed:
        txt_file = chunk_dir / f'{i:04d}.txt'
        seg_file = chunk_dir / f'{i:04d}.json'
        segs = []
        text = ''
        if txt_file.exists():
            text = txt_file.read_text('utf-8')
        if seg_file.exists():
            segs = json.loads(seg_file.read_text('utf-8'))
        chunk_results[i] = (text, segs)

    # 找出待处理的 chunk
    pending = [(i, c) for i, c in enumerate(chunks) if i not in completed]

    # 并行转写（每个线程从模型池获取独占实例）
    state['chunk_total'] = len(chunks)
    state['chunk_current'] = len(completed)
    save_state()
    with ThreadPoolExecutor(max_workers=max(1, min(len(_model_pool), _model_queue.qsize()))) as pool:
        futures = {pool.submit(transcribe_chunk, chunk, i, chunk_seconds): i for i, chunk in pending}

        for fut in as_completed(futures):
            try:
                idx, segs, text = fut.result()
            except TranscriptionCancelled:
                continue

            # 保存段结果
            (chunk_dir / f'{idx:04d}.txt').write_text(text, 'utf-8')
            (chunk_dir / f'{idx:04d}.json').write_text(
                json.dumps(segs, ensure_ascii=False), 'utf-8')
            chunk_results[idx] = (text, segs)

            # 更新进度
            completed.add(idx)
            progress_file.write_text(
                json.dumps({
                    'done': sorted(completed),
                    'chunk_seconds': chunk_seconds,
                    'chunk_policy': chunk_policy,
                }, ensure_ascii=False), 'utf-8')

            state['chunk_current'] = len(completed)
            state['chunk_total'] = len(chunks)
            save_state()

    _check_cancelled()

    # 按序合并所有段
    all_texts = []
    all_segments = []
    for i in sorted(chunk_results.keys()):
        text, segs = chunk_results[i]
        if text:
            all_texts.append(text)
        all_segments.extend(segs)

    # 合并最终结果（txt 做安全边界清理；srt 保持原时间轴，不改动）
    txt_path.write_text(add_ipa_to_text(clean_text_join(all_texts)), 'utf-8')
    with open(srt_path, 'w', encoding='utf-8') as f:
        for idx, seg in enumerate(all_segments, 1):
            f.write(f"{idx}\n{format_ts(seg['start'])} --> {format_ts(seg['end'])}\n{seg['text']}\n\n")

    # 清理临时文件
    shutil.rmtree(chunk_dir, ignore_errors=True)


def worker():
    # 防止其他入口意外重复调用 worker；模型池仍可并行处理单个视频的分块。
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
                    state['done'].append({'video': video_path, 'name': item['name'], 'status': 'ok', 'elapsed': round(elapsed, 1)})
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
            if state['cancel_requested']:
                state['queue'] = []
            state['transcribing'] = False
            state['current_video'] = ''
            # 保留取消标记供页面显示；启动下一次任务时清除。
            try:
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
        'transcribe_mode': state.get('transcribe_mode', 'standard'),
        'add_ipa': state.get('add_ipa', False),
        'chunk_mode': state.get('chunk_mode', 'auto'),
        'manual_chunk_seconds': state.get('manual_chunk_seconds', 5),
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
            'transcribe_mode': data.get('transcribe_mode', 'standard'),
            'add_ipa': data.get('add_ipa', False),
            'chunk_mode': data.get('chunk_mode', 'auto'),
            'manual_chunk_seconds': data.get('manual_chunk_seconds', 5),
            'queue': remaining,
            'done': data.get('done', []),
            'errors': data.get('errors', []),
            'total': data.get('total', 0),
            'remaining': len(remaining),
        }
    except Exception:
        return None
