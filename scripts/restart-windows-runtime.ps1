param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$runtimeState = Join-Path $ProjectRoot '.notion-switch'
$runtimeExecutable = Join-Path $runtimeState 'runtime\Notion.exe'
$taskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'

function Stop-VerifiedProcessTree($ProcessInfo) {
  $current = Get-Process -Id $ProcessInfo.Id -ErrorAction SilentlyContinue
  if (-not $current -or $current.StartTime -ne $ProcessInfo.StartTime -or $current.Path -ne $ProcessInfo.Path) { return }
  # Kill only the verified isolated tree, including speech/browser helpers.
  # A saved PID alone never proves that a process belongs to this project.
  $ErrorActionPreference = 'Continue'
  & $taskKill /PID $current.Id /T /F 2>$null | Out-Null
}

# Stop an unfinished Node launcher before it can spawn another runtime.
$launchLock = Join-Path $runtimeState 'launch.lock'
if (Test-Path -LiteralPath $launchLock -PathType Leaf) {
  $owner = $null
  try { $owner = Get-Content -LiteralPath $launchLock -Raw | ConvertFrom-Json } catch {}
  if ($owner -and $owner.pid -is [int] -and $owner.pid -gt 0) {
    $pending = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
    if ($pending -and $pending.ProcessName -eq 'node') {
      $details = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owner.pid) -ErrorAction Stop
      foreach ($entry in @('start-desktop.mjs', 'open-notion.mjs', 'open-settings.mjs', 'open-collection.mjs')) {
        $entryPath = Join-Path $ProjectRoot ('scripts\' + $entry)
        if ($details.CommandLine -and $details.CommandLine.IndexOf($entryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          Stop-VerifiedProcessTree $pending
          break
        }
      }
    }
  }
}

function Get-IsolatedRuntimeProcesses {
  Get-Process -Name Notion -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and [string]::Equals($_.Path, $runtimeExecutable, [StringComparison]::OrdinalIgnoreCase)
  }
}
$oldProcesses = @(Get-IsolatedRuntimeProcesses)
foreach ($oldProcess in $oldProcesses) { Stop-VerifiedProcessTree $oldProcess }
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (@(Get-IsolatedRuntimeProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if (@(Get-IsolatedRuntimeProcesses).Count -gt 0) { throw '旧的 Switch Notion 进程尚未退出，请稍后重新双击。' }

# Only transient metadata is removed; profile and configuration stay intact.
foreach ($file in @($launchLock, (Join-Path $runtimeState 'control.json'))) {
  if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
}
