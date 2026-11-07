"""Web app supervisor. All ASR is delegated to the shared GPU operator.

Restarting the web app restores its pending file queue. Completed operator
checkpoint parts remain in .gpu-operator_<source>-<identity>; the old dual
Torch/Whisper model pool is never loaded. A web-app restart is not evidence
of a zero-recovery GPU run.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent

RETRY_DELAY = 15        # 崩溃后等待，留出驱动恢复时间
FAST_FAIL_SECONDS = 20  # 存活短于此值视为“启动即失败”
MAX_FAST_FAILS = 3      # 连续启动即失败的上限，超过则放弃（多为端口占用/配置错误）


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else str(HERE / 'app.py')
    fast_fails = 0

    while True:
        print(f"\n{'=' * 50}\n  启动 {Path(target).name}\n{'=' * 50}", flush=True)
        t0 = time.time()
        try:
            env = dict(os.environ, TRANSCRIBER_AUTO_RESUME='1')
            rc = subprocess.call([sys.executable, target], cwd=str(HERE), env=env)
        except KeyboardInterrupt:
            print("\n[守护] 收到中断，退出", flush=True)
            return 0
        uptime = time.time() - t0

        if rc == 0:
            print("[守护] 正常退出", flush=True)
            return 0

        if uptime < FAST_FAIL_SECONDS:
            fast_fails += 1
            print(f"[守护] 启动即失败 (code={rc}, 存活 {uptime:.0f}s) 第 {fast_fails}/{MAX_FAST_FAILS} 次", flush=True)
            if fast_fails >= MAX_FAST_FAILS:
                print("[守护] 连续启动失败，放弃重启。请手动排查。", flush=True)
                return rc
        else:
            fast_fails = 0
            print(f"[守护] 崩溃退出 (code={rc}, 存活 {uptime:.0f}s)", flush=True)

        print(f"[守护] {RETRY_DELAY} 秒后自动重启，续传未完成的分块…", flush=True)
        try:
            time.sleep(RETRY_DELAY)
        except KeyboardInterrupt:
            print("\n[守护] 收到中断，退出", flush=True)
            return 0


if __name__ == '__main__':
    sys.exit(main())
