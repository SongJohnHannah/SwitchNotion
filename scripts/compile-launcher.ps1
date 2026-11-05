param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination, [string]$IconPath)
$ErrorActionPreference = 'Stop'
$Source = [IO.Path]::GetFullPath($Source)
$Destination = [IO.Path]::GetFullPath($Destination)
$code = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
if (-not $IconPath) {
  $iconName = if ([IO.Path]::GetFileName($Destination) -match '配置|更新') { 'notion-settings.ico' } else { 'notion.ico' }
  $IconPath = Join-Path (Split-Path -Parent (Split-Path -Parent $Source)) ('assets\' + $iconName)
}
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.OutputAssembly = $Destination
$parameters.CompilerOptions = '/target:winexe' + $(if (Test-Path -LiteralPath $IconPath) { ' /win32icon:"' + $IconPath + '"' } else { '' })
[void]$parameters.ReferencedAssemblies.Add('System.dll')
[void]$parameters.ReferencedAssemblies.Add('System.Windows.Forms.dll')
[void]$parameters.ReferencedAssemblies.Add('System.Drawing.dll')
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
  $compiled = $provider.CompileAssemblyFromSource($parameters, $code)
  if ($compiled.Errors.HasErrors) { throw ($compiled.Errors | Out-String) }
} finally { $provider.Dispose() }
