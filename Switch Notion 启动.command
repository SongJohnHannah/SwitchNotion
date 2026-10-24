#!/bin/sh
set -eu
project=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
exec /bin/sh "$project/scripts/launch-macos.sh" notion "$project"
