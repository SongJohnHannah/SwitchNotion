#!/bin/sh
set -eu
project=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
export NOTION_SWITCH_ROOT="${NOTION_SWITCH_ROOT:-$project/.notion-switch/mac-arm64}"
if [ -f "$project/Switch Notion.app/Contents/MacOS/SwitchNotion" ]; then
  chmod u+x "$project/Switch Notion.app/Contents/MacOS/SwitchNotion"
  exec /bin/sh "$project/Switch Notion.app/Contents/MacOS/SwitchNotion"
fi
exec /bin/sh "$project/scripts/launch-macos.sh" notion "$project"
