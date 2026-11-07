"""Offline adapter harness; the shared bundle owns all GPU inference and locking."""
import argparse
import json
import signal
import sys
import time
from pathlib import Path

import core
from gpu_operator import OperatorBridge


def main(argv=None):
    parser = argparse.ArgumentParser(description='统一 Turbo 稳定 GPU 逐字稿入口')
    parser.add_argument('source', nargs='?', help='音视频完整路径')
    parser.add_argument('--output-dir', help='导出的 TXT/SRT 及独立算子记录目录')
    parser.add_argument('--language', choices=('auto', 'en', 'zh'), default='auto')
    parser.add_argument('--describe', action='store_true', help='仅检查资源，不加载 GPU 模型')
    args = parser.parse_args(argv)
    if args.describe:
        print(json.dumps({'event': 'description', 'result': OperatorBridge().describe()}, ensure_ascii=False))
        return 0
    if not args.source or not args.output_dir:
        parser.error('转写需要 source 和 --output-dir')
    source, output = Path(args.source).resolve(), Path(args.output_dir).resolve()
    if not source.is_file():
        parser.error('音视频文件不存在')
    output.mkdir(parents=True, exist_ok=True)
    # This CLI has its own state file so a benchmark cannot replace the web queue.
    core.STATE_FILE = output / 'transcriber-cli-state.json'
    core.state.update(video_dir=str(source.parent), output_dir=str(output), language=args.language,
                      cancel_requested=False, transcribing=True, queue=[{'path': str(source), 'name': source.stem}],
                      done=[], errors=[], total=1, current_index=0, operator_outputs={})
    previous_handler = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, lambda _number, _frame: core.state.update(cancel_requested=True))
    before = time.perf_counter()
    try:
        result = core.transcribe_one(str(source), language=args.language)
        core.state.update(queue=[], done=[{'video': str(source), 'status': 'ok'}], current_index=1)
        core.save_state()
        print(json.dumps({'event': 'result', 'result': result,
                          'adapterWallSeconds': time.perf_counter() - before,
                          'timingScope': 'adapter-call-includes-bridge-model-load-and-preprocessing'}, ensure_ascii=False))
        return 0
    except core.TranscriptionCancelled as error:
        print(json.dumps({'event': 'error', 'code': 'CANCELLED', 'message': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except Exception as error:
        print(json.dumps({'event': 'error', 'code': 'OPERATOR_FAILURE', 'message': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        core.state['transcribing'] = False
        signal.signal(signal.SIGINT, previous_handler)


if __name__ == '__main__':
    raise SystemExit(main())
