param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime] > $null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] > $null
[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime] > $null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] > $null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime] > $null
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await-Result($Operation, [Type]$Type) { $task = $asTask.MakeGenericMethod($Type).Invoke($null, @($Operation)); $task.GetAwaiter().GetResult() }
function Await-Action($Operation) { $task = $asAction.Invoke($null, @($Operation)); $null = $task.GetAwaiter().GetResult() }
$request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'OCR language pack not installed' }
$file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.file)) ([Windows.Storage.StorageFile])
$results = New-Object System.Collections.Generic.List[object]
function Read-Bitmap($Stream, $Number) {
  $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($Stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $ratio = [Math]::Min(1, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
  $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $ratio))
  $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $ratio))
  $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object { $_.Text })
    $results.Add(@{ page = $Number; text = ($lines -join "`n") })
  } finally { $bitmap.Dispose() }
}
if ($request.pdf) {
  $document = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  if ($document.PageCount -lt 1 -or $document.PageCount -gt $request.maxPages) { throw 'PDF page count exceeds limit' }
  $numbers = if ($null -eq $request.pages) { @(1..$document.PageCount) } else { @($request.pages) }
  foreach ($number in $numbers) {
    if ($number -lt 1 -or $number -gt $document.PageCount) { throw 'Invalid PDF page number' }
    $page = $document.GetPage([uint32]($number - 1)); $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    try {
      $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $ratio = [Math]::Min(1, 2400 / [Math]::Max($page.Size.Width * 2, $page.Size.Height * 2))
      $options.DestinationWidth = [uint32][Math]::Max(1, $page.Size.Width * 2 * $ratio)
      $options.DestinationHeight = [uint32][Math]::Max(1, $page.Size.Height * 2 * $ratio)
      Await-Action ($page.RenderToStreamAsync($stream, $options)); $stream.Seek(0)
      Read-Bitmap $stream ([int]$number)
    } finally { $stream.Dispose(); $page.Dispose() }
  }
} else {
  $stream = Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try { Read-Bitmap $stream 1 } finally { $stream.Dispose() }
}
@{ pages = @($results.ToArray()); languages = @($engine.RecognizerLanguage.LanguageTag) } | ConvertTo-Json -Depth 6 -Compress
