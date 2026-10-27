#!/bin/sh
set -eu
umask 077
project=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
applications=${SWITCH_NOTION_APPLICATIONS_DIR:-/Applications}
case "$applications" in /*) ;; *) echo '应用程序目录必须是绝对路径。'; exit 1 ;; esac
if [ ! -f "$project/scripts/launch-macos.sh" ] || [ ! -f "$project/scripts/macos-app-launcher.m" ] || [ ! -f "$project/assets/notion.icns" ]; then
  echo '找不到项目启动文件或图标，请在项目文件夹内运行此脚本。'; exit 1
fi
if [ ! -d "$applications" ]; then echo '找不到应用程序目录。'; exit 1; fi
target="$applications/SwitchNotion.app"
is_ours() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/Contents/Info.plist" ] &&
    [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null || true)" = 'com.notionswitch.project-launcher' ] &&
    [ "$(/usr/bin/plutil -extract SwitchNotionProjectPath raw -o - "$1/Contents/Info.plist" 2>/dev/null || true)" = "$project" ]
}
if { [ -e "$target" ] || [ -L "$target" ]; } && ! is_ours "$target"; then
  echo "应用程序目录中已有其他 SwitchNotion.app，未覆盖：$target"; exit 1
fi
staging=$(mktemp -d "$applications/.switch-notion-install.XXXXXX")
cleanup() { if [ -n "$staging" ] && [ -d "$staging" ]; then rm -rf -- "$staging"; fi; }
trap cleanup EXIT HUP INT TERM
app="$staging/SwitchNotion.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$project/assets/notion.icns" "$app/Contents/Resources/notion.icns"
plist="$app/Contents/Info.plist"
/usr/bin/plutil -create xml1 "$plist"
/usr/bin/plutil -insert CFBundleName -string 'SwitchNotion' "$plist"
/usr/bin/plutil -insert CFBundleDisplayName -string 'SwitchNotion' "$plist"
/usr/bin/plutil -insert CFBundleIdentifier -string 'com.notionswitch.project-launcher' "$plist"
/usr/bin/plutil -insert CFBundleExecutable -string 'SwitchNotion' "$plist"
/usr/bin/plutil -insert CFBundleIconFile -string 'notion.icns' "$plist"
/usr/bin/plutil -insert CFBundlePackageType -string 'APPL' "$plist"
/usr/bin/plutil -insert CFBundleShortVersionString -string '1.0' "$plist"
/usr/bin/plutil -insert LSMinimumSystemVersion -string '13.0' "$plist"
/usr/bin/plutil -insert LSUIElement -bool YES "$plist"
/usr/bin/plutil -insert SwitchNotionProjectPath -string "$project" "$plist"
/usr/bin/plutil -insert NSDownloadsFolderUsageDescription -string 'SwitchNotion 需要读取下载文件夹中的项目，以启动应用。' "$plist"
/usr/bin/plutil -insert NSDocumentsFolderUsageDescription -string 'SwitchNotion 需要读取文稿文件夹中的项目，以启动应用。' "$plist"
/usr/bin/plutil -insert NSDesktopFolderUsageDescription -string 'SwitchNotion 需要读取桌面上的项目，以启动应用。' "$plist"
if ! /usr/bin/xcrun clang -fobjc-arc -framework Cocoa "$project/scripts/macos-app-launcher.m" -o "$app/Contents/MacOS/SwitchNotion"; then
  echo '无法编译启动器，请安装 macOS 命令行开发工具后重试。'; exit 1
fi
/usr/bin/codesign --force --deep --sign - "$app"
if [ -e "$target" ] || [ -L "$target" ]; then
  if ! is_ours "$target"; then echo '安装期间目标已变化，未覆盖。'; exit 1; fi
  mv "$target" "$staging/previous.app"
  if ! mv "$app" "$target"; then mv "$staging/previous.app" "$target"; exit 1; fi
else
  mv "$app" "$target"
fi
old="$applications/Switch Notion.app"
if is_ours "$old"; then mv "$old" "$staging/previous-name.app"; fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" || true
/usr/bin/mdimport "$target" || true
echo "已安装：$target"
