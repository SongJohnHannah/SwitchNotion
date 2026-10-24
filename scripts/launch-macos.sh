#!/bin/sh
set -eu
umask 077
target=${1:-notion}
project=${2:-$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)}
case "$target" in notion|settings|update) ;; *) exit 2 ;; esac
if [ "$(uname -s)" != Darwin ]; then echo '此入口用于 Apple Silicon Mac；Windows 请双击项目内的 Windows 启动程序。'; exit 1; fi
if [ "$(uname -m)" != arm64 ]; then /usr/bin/osascript -e 'display alert "Switch Notion" message "请在 M1 等 Apple Silicon Mac 的原生 ARM64 环境中启动。"'; exit 1; fi
state=${NOTION_SWITCH_ROOT:-$project/.notion-switch}
case "$state" in /*) ;; *) exit 2 ;; esac
mkdir -p "$state"
export NOTION_SWITCH_ROOT="$state"
valid_node() { [ -f "$1" ] && [ -x "$1" ] && "$1" -e 'if(process.platform!=="darwin"||process.arch!=="arm64"||Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1; }
node=''
node_home="$state/runtime-node/node-v22.22.3-darwin-arm64"
for candidate in "$project/bin/node" "$node_home/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node || true)"; do
  if valid_node "$candidate"; then node=$candidate; break; fi
done
if [ -z "$node" ]; then
  answer=$(/usr/bin/osascript -e 'button returned of (display dialog "首次启动需要下载官方 Node.js ARM64 运行环境（仅保存到本机，无需管理员权限）。准备完成后会自动打开 Switch Notion。" with title "Switch Notion" buttons {"取消", "继续"} default button "继续" cancel button "取消")') || exit 0
  [ "$answer" = '继续' ] || exit 0
  download_tmp=$(mktemp -d "$state/node-download.XXXXXX")
  cleanup() { case "$download_tmp" in "$state"/node-download.*) rm -rf -- "$download_tmp" ;; esac; }
  trap cleanup EXIT HUP INT TERM
  archive="$download_tmp/node.tar.gz"
  if ! /usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --silent --show-error --connect-timeout 15 --max-time 180 --retry 1 -o "$archive" 'https://nodejs.org/dist/v22.22.3/node-v22.22.3-darwin-arm64.tar.gz'; then
    /usr/bin/osascript -e 'display alert "Switch Notion" message "运行环境下载未完成。请检查网络后再次双击启动，现有资料已保留。"'; exit 1
  fi
  actual=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')
  if [ "$actual" != '0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207' ]; then
    /usr/bin/osascript -e 'display alert "Switch Notion" message "官方运行环境校验失败，未安装或执行下载文件。请稍后重新启动。"'; exit 1
  fi
  /usr/bin/tar -xzf "$archive" -C "$download_tmp"
  mkdir -p "$state/runtime-node"
  if [ -e "$node_home" ]; then mv "$node_home" "$node_home.previous-$(date +%s)"; fi
  mv "$download_tmp/node-v22.22.3-darwin-arm64" "$node_home"
  node="$node_home/bin/node"
  if ! valid_node "$node"; then /usr/bin/osascript -e 'display alert "Switch Notion" message "本机无法运行 ARM64 环境，请确认 macOS 系统版本。"'; exit 1; fi
fi
cd "$project"
if ! "$node" "$project/scripts/launch-macos.mjs" "$target" >"$state/launcher-last.log" 2>&1; then
  /usr/bin/osascript - "$state/launcher-last.log" <<'APPLESCRIPT'
on run argv
  display alert "Switch Notion 启动未完成" message ("现有资料已保留。详细结果保存在：" & item 1 of argv & "。如果 macOS 显示系统确认窗口，请由你本人完成确认。")
end run
APPLESCRIPT
  exit 1
fi
echo 'Switch Notion 已打开，本窗口可以关闭。'
