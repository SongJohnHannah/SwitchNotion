"""UTF-8 JSONL client for the shared, GPU-only standalone operator."""
import json
import os
import queue
import re
import subprocess
import threading
import time
from collections import deque
from pathlib import Path


DEFAULT_BUNDLE = Path(r'D:\迅雷下载\notionSwitch\GPU转写算子')


class OperatorError(RuntimeError):
    pass


class OperatorCancelled(OperatorError):
    """The operator stopped; its completed checkpoint parts remain on disk."""


class OperatorBridge:
    def __init__(self, bundle=None, *, command=None):
        self.bundle = Path(bundle or os.environ.get('TRANSCRIBER_GPU_BUNDLE') or DEFAULT_BUNDLE).resolve()
        # Explicit command injection is for a protocol fixture, never a UI option.
        self._command = list(command) if command is not None else None

    def _exchange(self, request, expected_event, on_progress=None, is_cancelled=None, timeout=None):
        if is_cancelled and is_cancelled():
            raise OperatorCancelled('转写已取消，独立算子检查点已保留')
        command = self._command
        if command is None:
            node, script = self.bundle / 'bin/node.exe', self.bundle / 'bridge.mjs'
            if not node.is_file() or not script.is_file():
                raise OperatorError(f'独立 GPU 算子入口未就绪：{self.bundle}')
            command = [str(node), str(script)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace',
                                   bufsize=1, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        stderr = deque(maxlen=30)
        reader = threading.Thread(target=lambda: stderr.extend(process.stderr), daemon=True)
        reader.start()
        lines = queue.Queue()

        def read_stdout():
            try:
                for line in process.stdout:
                    lines.put(line)
            finally:
                lines.put(None)

        stdout_reader = threading.Thread(target=read_stdout, daemon=True)
        stdout_reader.start()
        result, failure, failure_code = None, None, None
        started, cancel_at = time.monotonic(), None
        try:
            process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
            process.stdin.flush()
            if expected_event == 'description':
                # A metadata query has no later cancel message. EOF also lets
                # Node release its stdin handle and finish naturally.
                process.stdin.close()
            while True:
                if is_cancelled and is_cancelled() and cancel_at is None:
                    cancel_at = time.monotonic()
                    try:
                        process.stdin.write('{"type":"cancel"}\n')
                        process.stdin.flush()
                    except (BrokenPipeError, OSError, ValueError):
                        pass
                if cancel_at is not None and time.monotonic() - cancel_at > 30:
                    raise OperatorCancelled('转写取消超时，已结束桥接进程；已完成检查点保留')
                if timeout is not None and time.monotonic() - started > timeout:
                    raise OperatorError('GPU 算子状态查询超时')
                try:
                    line = lines.get(timeout=.1)
                except queue.Empty:
                    continue
                if line is None:
                    break
                try:
                    event = json.loads(line)
                except (ValueError, TypeError) as error:
                    raise OperatorError('GPU 算子返回了无效 JSONL') from error
                if event.get('event') == 'progress' and on_progress:
                    on_progress(event)
                elif event.get('event') == expected_event:
                    result = event.get('result')
                    process.stdin.close()
                elif event.get('event') == 'error':
                    failure = event.get('error') or event.get('message') or 'GPU 算子失败'
                    failure_code = event.get('code')
                    process.stdin.close()
            code = process.wait()
            reader.join(1)
            if cancel_at is not None or failure_code == 'CANCELLED' or (is_cancelled and is_cancelled()):
                raise OperatorCancelled('转写已取消，独立算子检查点已保留')
            if code or failure:
                detail = str(failure or ''.join(stderr).strip() or f'exit={code}')[-2000:]
                raise OperatorError(f'GPU 算子失败：{detail}')
            if not isinstance(result, dict):
                raise OperatorError(f'GPU 算子缺少 {expected_event} 结果')
            return result
        finally:
            if process.poll() is None:
                if os.name == 'nt':
                    # Only this client-owned bridge tree; never a broad python/node kill.
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                   capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
            reader.join(1)
            stdout_reader.join(1)

    def transcribe(self, source, output_directory, *, language='auto', on_progress=None, is_cancelled=None):
        if language not in ('auto', 'en', 'zh'):
            raise OperatorError('无效的转写语言')
        request = {'type': 'transcribe', 'source': str(Path(source).resolve()),
                   'outputDirectory': str(Path(output_directory).resolve()), 'language': language}
        profile = os.environ.get('TRANSCRIBER_GPU_PROFILE', 'winner')
        experimental = os.environ.get('TRANSCRIBER_GPU_ALLOW_EXPERIMENTAL') == '1'
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', profile):
            raise OperatorError('无效的 GPU 算子 profile')
        if profile != 'winner' and not experimental:
            raise OperatorError('实验 profile 仅在显式允许实验时可运行')
        if profile != 'winner' or experimental:
            request.update(profile=profile, allowExperimental=experimental)
        result = self._exchange(request, 'result', on_progress, is_cancelled)
        if result.get('complete') is not True or result.get('device') != 'cuda':
            raise OperatorError('独立算子没有返回完整 CUDA 转写结果；不会回退 CPU')
        if not isinstance(result.get('text'), str) or not isinstance(result.get('segments'), list):
            raise OperatorError('GPU 算子返回缺少原文或完整时间段')
        return result

    def describe(self):
        """Read static operator metadata; this request never loads a GPU model."""
        return self._exchange({'type': 'describe'}, 'description', timeout=20)
