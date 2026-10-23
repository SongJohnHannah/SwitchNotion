param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$ProjectRoot)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'NotionSwitch · 准备 Notion'
$form.Size = New-Object Drawing.Size(600,290)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI',10)
$title = New-Object Windows.Forms.Label
$title.Text = '没有找到可用的 Notion 桌面版'
$title.Location = New-Object Drawing.Point(24,20)
$title.Size = New-Object Drawing.Size(550,30)
$form.Controls.Add($title)
$description = New-Object Windows.Forms.Label
$description.Text = '先从官网下载并登录 Notion，再点击“重新检测”。如果已经安装在其他位置，可以选择 Notion.exe。'
$description.Location = New-Object Drawing.Point(24,60)
$description.Size = New-Object Drawing.Size(550,55)
$form.Controls.Add($description)
$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Location = New-Object Drawing.Point(24,180)
$statusLabel.Size = New-Object Drawing.Size(550,50)
$form.Controls.Add($statusLabel)
function Test-Source([string]$Selected) {
  $helper = Join-Path $ProjectRoot 'scripts\find-notion.mjs'
  $raw = if ($Selected) { & $NodePath $helper --select $Selected } else { & $NodePath $helper }
  $info = $raw | ConvertFrom-Json
  if ($info.found) { $form.DialogResult = [Windows.Forms.DialogResult]::OK; $form.Close() }
  else { $statusLabel.Text = $info.message }
}
$download = New-Object Windows.Forms.Button
$download.Text = '打开 Notion 官网'
$download.Location = New-Object Drawing.Point(24,130)
$download.Size = New-Object Drawing.Size(170,36)
$download.Add_Click({ Start-Process 'https://www.notion.com/desktop' })
$form.Controls.Add($download)
$browse = New-Object Windows.Forms.Button
$browse.Text = '选择 Notion.exe'
$browse.Location = New-Object Drawing.Point(205,130)
$browse.Size = New-Object Drawing.Size(170,36)
$browse.Add_Click({
  $picker = New-Object Windows.Forms.OpenFileDialog
  $picker.Title = '选择已安装的 Notion 桌面版'
  $picker.Filter = 'Notion 桌面版 (Notion.exe)|Notion.exe'
  if ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { Test-Source $picker.FileName }
  $picker.Dispose()
})
$form.Controls.Add($browse)
$retry = New-Object Windows.Forms.Button
$retry.Text = '重新检测'
$retry.Location = New-Object Drawing.Point(386,130)
$retry.Size = New-Object Drawing.Size(170,36)
$retry.Add_Click({ Test-Source '' })
$form.Controls.Add($retry)
$form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK
$form.Dispose()
