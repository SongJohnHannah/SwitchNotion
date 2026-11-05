param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z-]+$')][string]$BaseName,
  [Parameter(Mandatory=$true)][string]$RuntimePng
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sourcePath = [IO.Path]::GetFullPath($Source)
$runtimePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $RuntimePng))
if (-not $runtimePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Icon output must stay within the project directory.' }
$image = [Drawing.Image]::FromFile($sourcePath)
$frames = @{}
try {
  foreach ($size in @(16,24,32,48,64,128,256,512,1024)) {
    $bitmap = New-Object Drawing.Bitmap($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object IO.MemoryStream
    try {
      $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.Clear([Drawing.Color]::Transparent)
      $graphics.DrawImage($image, (New-Object Drawing.Rectangle(0,0,$size,$size)))
      $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
      $frames[$size] = $stream.ToArray()
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
  }
} finally { $image.Dispose() }
$assets = Join-Path $projectRoot 'assets'
$icoPath = Join-Path $assets ($BaseName + '.ico')
$writer = New-Object IO.BinaryWriter([IO.File]::Create($icoPath))
try {
  $sizes = @(16,24,32,48,64,128,256)
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  foreach ($size in $sizes) {
    $dimension = if ($size -eq 256) { 0 } else { $size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$frames[$size].Length); $writer.Write([uint32]$offset)
    $offset += $frames[$size].Length
  }
  foreach ($size in $sizes) { $writer.Write([byte[]]$frames[$size]) }
} finally { $writer.Dispose() }
function Write-BigEndian32($Writer,[uint32]$Value) {
  $bytes = [BitConverter]::GetBytes($Value)
  [Array]::Reverse($bytes)
  $Writer.Write([byte[]]$bytes)
}
$icnsPath = Join-Path $assets ($BaseName + '.icns')
$chunks = @(@('icp4',16),@('icp5',32),@('icp6',64),@('ic07',128),@('ic08',256),@('ic09',512),@('ic10',1024),@('ic11',32),@('ic12',64),@('ic13',256),@('ic14',512))
$length = 8
foreach ($chunk in $chunks) { $length += 8 + $frames[$chunk[1]].Length }
$writer = New-Object IO.BinaryWriter([IO.File]::Create($icnsPath))
try {
  $writer.Write([Text.Encoding]::ASCII.GetBytes('icns')); Write-BigEndian32 $writer $length
  foreach ($chunk in $chunks) {
    $writer.Write([Text.Encoding]::ASCII.GetBytes($chunk[0]))
    Write-BigEndian32 $writer (8 + $frames[$chunk[1]].Length)
    $writer.Write([byte[]]$frames[$chunk[1]])
  }
} finally { $writer.Dispose() }
[IO.Directory]::CreateDirectory((Split-Path -Parent $runtimePath)) | Out-Null
[IO.File]::WriteAllBytes($runtimePath,[byte[]]$frames[256])
[IO.File]::Copy($icoPath,[IO.Path]::ChangeExtension($runtimePath,'.ico'),$true)
[IO.File]::Copy($icnsPath,[IO.Path]::ChangeExtension($runtimePath,'.icns'),$true)
Write-Output ($icoPath + ' | ' + $icnsPath + ' | ' + $runtimePath)
