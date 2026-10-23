param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$code = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Windows.Forms.dll' -OutputAssembly $Destination -OutputType WindowsApplication
