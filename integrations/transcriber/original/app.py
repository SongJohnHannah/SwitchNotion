"""
逐字稿生成器 — Web 界面启动入口
双击 启动逐字稿.bat 即可使用
"""

import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import os
import time
import threading
import webbrowser
from pathlib import Path
from flask import Flask, jsonify, request, render_template

from core import (
    state, PORT, STATE_FILE, TARGET_INSTANCES,
    AVAILABLE_MODELS, TRANSCRIBE_MODES,
    init_models, switch_model, scan_media, get_output_paths,
    worker, save_state, load_state,
)
import core  # 通过模块引用访问可变变量（_model_ready, _model_pool, WHISPER_MODEL 等）

app = Flask(__name__, template_folder=str(Path(__file__).parent / 'templates'))


# ─── API ───

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/resume_check')
def api_resume_check():
    with core.task_lock:
        if state['transcribing']:
            return jsonify({'running': True, 'remaining': 0, **_task_settings()})
        saved = load_state()
        return jsonify(saved or {'remaining': 0})


def _task_settings():
    return {
        'video_dir': state['video_dir'],
        'output_dir': state['output_dir'],
        'cancel_requested': state['cancel_requested'],
        'chunk_mode': state.get('chunk_mode', 'auto'),
        'manual_chunk_seconds': state.get('manual_chunk_seconds', 5),
    }


def _resume_from(saved: dict):
    """把存档进度灌回 state 并启动 worker"""
    with core.task_lock:
        if state['transcribing']:
            return False
        state['video_dir'] = saved['video_dir']
        state['output_dir'] = saved['output_dir'] or saved['video_dir']
        state['overwrite'] = saved['overwrite']
        state['transcribe_mode'] = saved.get('transcribe_mode', 'standard')
        state['add_ipa'] = saved.get('add_ipa', False)
        state['chunk_mode'] = saved.get('chunk_mode', 'auto')
        state['manual_chunk_seconds'] = saved.get('manual_chunk_seconds', 5)
        state['queue'] = saved['queue']
        state['total'] = saved['total']
        state['current_index'] = saved.get('current_index', saved['total'] - len(saved['queue']))
        state['done'] = saved['done']
        state['errors'] = saved['errors']
        state['elapsed_per_video'] = []
        state['start_time'] = time.time()
        state['cancel_requested'] = False
        state['transcribing'] = True

        threading.Thread(target=worker, daemon=True).start()
        return True


@app.route('/api/resume', methods=['POST'])
def api_resume():
    with core.task_lock:
        if state['transcribing']:
            return jsonify({'status': 'running', **_task_settings()})
        saved = load_state()
        if not saved:
            return jsonify({'error': '没有可恢复的任务'}), 400

        _resume_from(saved)

        return jsonify({
            'status': 'resumed',
            'remaining': len(saved['queue']),
            **_task_settings(),
        })


@app.route('/api/resume_discard', methods=['POST'])
def api_resume_discard():
    with core.task_lock:
        if state['transcribing']:
            return jsonify({'error': '任务仍在运行，不能丢弃进度'}), 409
        STATE_FILE.unlink(missing_ok=True)
        return jsonify({'status': 'discarded'})


_system_info = None


@app.route('/api/system')
def api_system():
    global _system_info
    if _system_info is None:
        import torch
        _system_info = {
            'cuda': torch.cuda.is_available(),
            'torch_version': torch.__version__,
        }
        if _system_info['cuda']:
            _system_info['gpu_name'] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            _system_info['gpu_vram'] = round(props.total_memory / 1024 / 1024)
    return jsonify({**_system_info, 'model_info': state.get('model_info', ''), 'model_instances': state.get('model_instances', 0), 'model_name': core.WHISPER_MODEL})


@app.route('/api/shutdown', methods=['POST'])
def api_shutdown():
    d = request.json or {}
    force = d.get('force', False)
    with core.task_lock:
        if state['transcribing'] and not force:
            return jsonify({'error': '转写进行中，请先取消任务或强制关闭'}), 409
        # 强制关闭保留当前队列，重启后可恢复，避免与 worker 同时清空队列。
        save_state()
    threading.Thread(target=_shutdown, daemon=True).start()
    return jsonify({'status': 'shutting_down'})


def _shutdown():
    os._exit(0)


@app.route('/api/pick_folder')
def api_pick_folder():
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    init_dir = request.args.get('init', state['video_dir'])
    folder = filedialog.askdirectory(title='选择文件夹', initialdir=init_dir)
    root.destroy()
    return jsonify({'path': folder})


@app.route('/api/scan', methods=['POST'])
def api_scan():
    d = request.json or {}
    vdir = d.get('video_dir', state['video_dir'])
    with core.task_lock:
        if not state['transcribing']:
            state['video_dir'] = vdir
    videos = scan_media(vdir)
    return jsonify({'videos': videos, 'total': len(videos)})


@app.route('/api/transcribe', methods=['POST'])
def api_transcribe():
    with core.task_lock:
        if state['transcribing']:
            return jsonify({'error': '已有任务正在转写或取消，请等待结束'}), 409

        d = request.json or {}
        videos = d.get('videos', [])
        if not videos:
            return jsonify({'error': '请选择音视频文件'}), 400
        state['video_dir'] = d.get('video_dir') or state['video_dir']
        state['output_dir'] = d.get('output_dir') or state['video_dir']
        state['overwrite'] = d.get('overwrite', False)
        mode = d.get('transcribe_mode', 'standard')
        state['transcribe_mode'] = mode if mode in TRANSCRIBE_MODES else 'standard'
        state['add_ipa'] = bool(d.get('add_ipa', False))
        state['chunk_mode'] = d.get('chunk_mode', 'auto')
        try:
            state['manual_chunk_seconds'] = max(1, min(10, int(d.get('manual_chunk_seconds', 5))))
        except (TypeError, ValueError):
            state['manual_chunk_seconds'] = 5

        queue = []
        skipped = []
        for v in videos:
            txt_path, _ = get_output_paths(v['path'])
            if txt_path.exists() and not state['overwrite']:
                skipped.append(v)
            else:
                queue.append(v)

        if not queue:
            return jsonify({'error': '所有选中文件已有逐字稿，请勾选"覆盖已有"', 'skipped': len(skipped)}), 400

        state['queue'] = queue
        state['total'] = len(queue)
        state['current_index'] = 0
        state['done'] = []
        state['errors'] = []
        state['elapsed_per_video'] = []
        state['start_time'] = time.time()
        state['cancel_requested'] = False
        state['transcribing'] = True
        save_state()

        threading.Thread(target=worker, daemon=True).start()

        return jsonify({'status': 'started', 'total': len(queue), 'skipped': len(skipped)})


@app.route('/api/status')
def api_status():
    elapsed = time.time() - state['start_time'] if state['transcribing'] else 0
    idx = state['current_index']
    total = state['total']

    # Estimate remaining time
    eta = ''
    if state['transcribing'] and state['elapsed_per_video']:
        avg = sum(state['elapsed_per_video']) / len(state['elapsed_per_video'])
        remaining = total - idx
        eta_secs = avg * remaining
        if eta_secs > 60:
            eta = f'{int(eta_secs // 60)} 分钟'
        else:
            eta = f'{int(eta_secs)} 秒'

    return jsonify({
        'transcribing': state['transcribing'],
        **_task_settings(),
        'current_video': state['current_video'],
        'current_index': idx,
        'total': total,
        'progress': round(idx / total * 100, 1) if total > 0 else 0,
        'elapsed': round(elapsed, 1),
        'eta': eta,
        'done': state['done'],
        'errors': state['errors'],
        'chunk_current': state.get('chunk_current', 0),
        'chunk_total': state.get('chunk_total', 0),
        'chunk_seconds': state.get('chunk_seconds', 0),
        'chunk_policy': state.get('chunk_policy', ''),
        'phase': state.get('phase', ''),
        'transcribe_mode': state.get('transcribe_mode', 'standard'),
        'transcribe_mode_label': TRANSCRIBE_MODES.get(state.get('transcribe_mode', 'standard'), TRANSCRIBE_MODES['standard'])['label'],
        'add_ipa': state.get('add_ipa', False),
        'chunk_mode': state.get('chunk_mode', 'auto'),
        'manual_chunk_seconds': state.get('manual_chunk_seconds', 5),
    })


@app.route('/api/cancel', methods=['POST'])
def api_cancel():
    with core.task_lock:
        if state['transcribing']:
            state['cancel_requested'] = True
            return jsonify({'status': 'cancelling'})
        return jsonify({'status': 'cancelled'})


@app.route('/api/transcript')
def api_transcript():
    path = request.args.get('path', '')
    if not path:
        return jsonify({'text': '', 'exists': False})
    txt = Path(path).with_suffix('.txt')
    if txt.exists():
        return jsonify({'text': txt.read_text(encoding='utf-8'), 'exists': True, 'path': str(txt)})
    return jsonify({'text': '', 'exists': False})


@app.route('/api/open_folder')
def api_open_folder():
    path = request.args.get('path', '')
    if not path or not Path(path).exists():
        return jsonify({'error': '路径不存在'}), 400
    import subprocess as sp
    sp.Popen(f'explorer "{Path(path).resolve()}"')
    return jsonify({'status': 'ok'})


@app.route('/api/open_output_folder')
def api_open_output_folder():
    """根据视频路径，打开字幕文件所在的文件夹"""
    path = request.args.get('path', '')
    if not path:
        return jsonify({'error': '缺少路径'}), 400
    txt_path, _ = get_output_paths(path)
    folder = str(txt_path.parent)
    folder = str(Path(folder).resolve())
    if not Path(folder).exists():
        Path(folder).mkdir(parents=True, exist_ok=True)
    import subprocess as sp
    sp.Popen(f'explorer "{folder}"')
    return jsonify({'status': 'ok', 'folder': folder})


@app.route('/api/models')
def api_models():
    return jsonify({
        'models': AVAILABLE_MODELS,
        'current': core.WHISPER_MODEL,
    })


@app.route('/api/switch_model', methods=['POST'])
def api_switch_model():
    if state['transcribing']:
        return jsonify({'error': '转写进行中，无法切换模型'}), 400
    d = request.json or {}
    name = d.get('model', '')
    if name not in AVAILABLE_MODELS:
        return jsonify({'error': f'未知模型: {name}'}), 400

    def _do_switch():
        try:
            n = switch_model(name)
            print(f"  ✅ 切换到 {name}，{n} 个实例就绪\n")
        except Exception as e:
            print(f"  ❌ 切换模型失败: {e}\n")

    threading.Thread(target=_do_switch, daemon=True).start()
    return jsonify({'status': 'switching', 'model': name})


if __name__ == '__main__':
    print("=" * 50)
    print("  逐字稿生成器")
    print(f"  http://localhost:{PORT}")
    print("=" * 50)

    # 启动时预加载模型
    print("\n  加载模型中（首次需下载，请耐心等待）...")

    def _preload():
        try:
            n = init_models()
            if n > 0:
                print(f"  ✅ {n} 个模型实例就绪\n")
            else:
                print("  ❌ 模型加载失败\n")
        except Exception as e:
            print(f"  ❌ 模型加载失败: {e}\n")

    t = threading.Thread(target=_preload, daemon=True)
    t.start()

    # supervisor.py 重启本进程时设置此变量：崩溃后自动续跑。
    # 否则 app 只会重启并空等，任务停在界面上等人点“继续”，自动重启就失去意义。
    if os.environ.get('TRANSCRIBER_AUTO_RESUME') == '1':
        saved = load_state()
        if saved:
            print(f"  🔄 检测到未完成任务，自动续传 {len(saved['queue'])} 个\n")
            _resume_from(saved)

    # 模型加载状态 API
    @app.route('/api/model_status')
    def api_model_status():
        return jsonify({
            'loading': t.is_alive(),
            'ready': core._model_ready,
            'instances': len(core._model_pool),
            'model_name': core.WHISPER_MODEL,
            'target': TARGET_INSTANCES,
        })

    webbrowser.open(f'http://localhost:{PORT}')

    from waitress import serve
    print(f"  服务启动: http://localhost:{PORT}\n")
    serve(app, host='0.0.0.0', port=PORT)
