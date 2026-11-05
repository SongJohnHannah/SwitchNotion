param([ValidateSet('notion', 'settings', 'update')][string]$Target = 'notion')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $projectRoot '.notion-switch'
function Write-LaunchStatus([string]$Message) {
  if ($env:NOTION_SWITCH_LAUNCHER_UI -eq '1') { [Console]::WriteLine('NOTION_SWITCH_STATUS:' + $Message) }
}
try {
  Write-LaunchStatus '正在检查运行环境…'
  $nodePath = $null
  $bundledNode = Join-Path $projectRoot 'bin\node.exe'
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $nodePath = $bundledNode }
  $savedLauncher = Join-Path $stateDir 'launcher.local.json'
  if (-not $nodePath -and (Test-Path -LiteralPath $savedLauncher)) {
    $savedNode = (Get-Content -LiteralPath $savedLauncher -Raw | ConvertFrom-Json).nodeExecutable
    if ($savedNode -and (Test-Path -LiteralPath $savedNode -PathType Leaf) -and ([IO.Path]::GetFileName($savedNode) -match '^node(?:\.exe)?$')) { $nodePath = $savedNode }
  }
  if (-not $nodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath = $nodeCommand.Source }
  }
  if (-not $nodePath) { throw '没有找到 Node.js。请安装 Node.js 22 或更新版本，再双击项目内的启动入口。' }
  Write-LaunchStatus '正在查找 Notion 桌面版…'
  $notionInfo = & $nodePath (Join-Path $PSScriptRoot 'find-notion.mjs') | ConvertFrom-Json
  if (-not $notionInfo.found -and -not $notionInfo.canUseExistingRuntime) {
    Write-LaunchStatus '请在准备窗口中安装或选择 Notion 桌面版。'
    $selected = & (Join-Path $PSScriptRoot 'bootstrap-windows.ps1') -NodePath $nodePath -ProjectRoot $projectRoot
    if (-not $selected) { exit 0 }
  }
  $scriptName = if ($Target -eq 'settings') { 'open-settings.mjs' } elseif ($Target -eq 'update') { 'open-update.mjs' } else { 'open-notion.mjs' }
  Set-Location -LiteralPath $projectRoot
  Write-LaunchStatus '正在准备并打开窗口，首次启动或更新可能需要几分钟…'
  $ErrorActionPreference = 'Continue'
  $launchLines = New-Object 'System.Collections.Generic.List[string]'
  & $nodePath (Join-Path $PSScriptRoot $scriptName) 2>&1 | ForEach-Object {
    $line = [string]$_
    $launchLines.Add($line)
    if ($env:NOTION_SWITCH_LAUNCHER_UI -eq '1' -and $line.StartsWith('NOTION_SWITCH_STATUS:')) { [Console]::WriteLine($line) }
  }
  $launcherExit = $LASTEXITCODE
  $log = [string]::Join([Environment]::NewLine, $launchLines)
  $ErrorActionPreference = 'Stop'
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $stateDir 'launcher-last.log'), $log)
  if ($launcherExit -ne 0) { throw 'NotionSwitch 启动未完成。现有资料已保留；请稍后重试，详细结果保存在项目内 .notion-switch\launcher-last.log。' }
  if ($log -match '"runtimeRestored":true') { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('新版本未通过启动检查，已恢复上一个原型。以后可双击项目内的 NotionSwitch 更新.vbs 重试。', 'NotionSwitch') | Out-Null }
} catch {
  if ($env:NOTION_SWITCH_LAUNCHER_UI -eq '1') { [Console]::WriteLine('NOTION_SWITCH_ERROR:' + $_.Exception.Message) }
  else {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'NotionSwitch') | Out-Null
  }
  exit 1
}
