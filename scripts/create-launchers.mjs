import fs from 'node:fs';
import path from 'node:path';
import { project } from './prepare-desktop.mjs';
const results = [];
for (const [name, target] of [['NotionSwitch 配置', 'settings'], ['NotionSwitch 启动', 'notion'], ['NotionSwitch 更新', 'update']]) {
  const launcher = path.join(project, name + '.vbs');
  const source = `Option Explicit\r\nDim shell, files, base, command\r\nSet shell = CreateObject("WScript.Shell")\r\nSet files = CreateObject("Scripting.FileSystemObject")\r\nbase = files.GetParentFolderName(WScript.ScriptFullName)\r\nshell.CurrentDirectory = base\r\ncommand = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & base & "\\scripts\\launch.ps1"" -Target ${target}"\r\nshell.Run command, 0, False\r\n`;
  fs.writeFileSync(launcher, Buffer.concat([Buffer.from([255, 254]), Buffer.from(source, 'utf16le')]));
  results.push({ launcher });
}
console.log(JSON.stringify({ launchers: results }));
