param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$Source = [IO.Path]::GetFullPath($Source)
$Destination = [IO.Path]::GetFullPath($Destination)
$code = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
$iconPath = Join-Path (Split-Path -Parent (Split-Path -Parent $Source)) 'assets\notion.ico'
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.OutputAssembly = $Destination
$parameters.CompilerOptions = '/target:winexe' + $(if (Test-Path -LiteralPath $iconPath) { ' /win32icon:"' + $iconPath + '"' } else { '' })
[void]$parameters.ReferencedAssemblies.Add('System.dll')
[void]$parameters.ReferencedAssemblies.Add('System.Windows.Forms.dll')
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
  $compiled = $provider.CompileAssemblyFromSource($parameters, $code)
  if ($compiled.Errors.HasErrors) { throw ($compiled.Errors | Out-String) }
} finally { $provider.Dispose() }
