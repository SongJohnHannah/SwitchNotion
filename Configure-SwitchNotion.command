#!/bin/sh
set -eu
project=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
export NOTION_SWITCH_ROOT="${NOTION_SWITCH_ROOT:-$project/.notion-switch/mac-arm64}"
exec /bin/sh "$project/scripts/launch-macos.sh" settings "$project"
