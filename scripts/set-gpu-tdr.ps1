# Reversible GPU watchdog settings for long CUDA inference on Windows.
# Run in an elevated PowerShell. Reboot is required for both apply and revert.
param([switch]$Revert)
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers'
if ($Revert) {
    Set-ItemProperty -Path $key -Name TdrDelay -Type DWord -Value 2
    Set-ItemProperty -Path $key -Name TdrDdiDelay -Type DWord -Value 5
    Set-ItemProperty -Path $key -Name HwSchMode -Type DWord -Value 2
    Write-Output 'Reverted: TdrDelay=2 TdrDdiDelay=5 HwSchMode=2 (HAGS on). Reboot required.'
} else {
    Set-ItemProperty -Path $key -Name TdrDelay -Type DWord -Value 10
    Set-ItemProperty -Path $key -Name TdrDdiDelay -Type DWord -Value 10
    Set-ItemProperty -Path $key -Name HwSchMode -Type DWord -Value 1
    Write-Output 'Applied: TdrDelay=10 TdrDdiDelay=10 HwSchMode=1 (HAGS off). Reboot required.'
}
