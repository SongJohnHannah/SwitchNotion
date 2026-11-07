"""崩溃自愈启动器

背景：这张 RTX 2070 改卡（8GB→16GB，功耗墙 115W）在显存带宽负载下会随机触发
NVIDIA 驱动 TDR，把整个转写进程直接杀掉。存活次数在 1~8 次推理调用之间随机，
换 batch_size / 实例数 / CUDA 分配器都无法消除（已实测）。

transcribe_one 已按分块落盘（.chunks_<名>/_progress.json），重启后会跳过已完成
分块继续。本脚本负责崩溃后自动重启，让长视频无人值守跑完。

用法: python supervisor.py [目标脚本]，默认 app.py
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
