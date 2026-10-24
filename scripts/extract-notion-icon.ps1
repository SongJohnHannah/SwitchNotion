param([Parameter(Mandatory=$true)][string]$NotionExecutable, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($NotionExecutable)
if (-not $icon) { throw 'Unable to read the installed Notion icon.' }
$stream = [IO.File]::Create($Destination)
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
