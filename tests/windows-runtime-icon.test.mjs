import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import platformModule from '../src/platform/index.cjs';

test('Windows runtime finalization brands the actual executable used by Shell icon fallbacks and preserves the original installation',
  { skip: process.platform !== 'win32', timeout: 30000 }, t => {
    const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'test-runtime-icon-中文 '));
    t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
    const original = path.join(root, 'Original.exe'), staged = path.join(root, 'runtime');
    const source = path.join(root, 'fixture.cs');
    fs.writeFileSync(source, 'using System.Reflection; [assembly: AssemblyTitle("Icon fixture metadata")] class Fixture { static void Main() {} }');
    const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(framework, ['/nologo', '/target:winexe', '/out:' + original, source], { windowsHide: true, stdio: 'pipe' });
    const before = fs.readFileSync(original);
    const platform = platformModule.createDesktopPlatform({ id: 'win32' }), layout = platform.runtimeLayout(staged);
    fs.mkdirSync(path.join(layout.resources, 'notion-switch'), { recursive: true });
    fs.copyFileSync(original, layout.executable);
    fs.copyFileSync(path.resolve('src/app-icon.ico'), path.join(layout.resources, 'notion-switch/app-icon.ico'));
    platform.finalizeRuntime(layout);
    const ico = fs.readFileSync('src/app-icon.ico'), last = 6 + 16 * (ico.readUInt16LE(4) - 1);
    const frame = ico.subarray(ico.readUInt32LE(last + 12), ico.readUInt32LE(last + 12) + ico.readUInt32LE(last + 8));
    assert.ok(fs.readFileSync(layout.executable).includes(frame), 'The runtime executable still embeds its original icon, which Windows may use for the taskbar');
    assert.deepEqual(fs.readFileSync(original), before, 'Official installation bytes must stay untouched');
    const script = path.join(root, 'read-shell-icon.ps1');
    fs.writeFileSync(script, `param([string]$Executable)\nAdd-Type -AssemblyName System.Drawing\n$icon=[Drawing.Icon]::ExtractAssociatedIcon($Executable);$image=$icon.ToBitmap();$orange=0;for($x=0;$x -lt $image.Width;$x++){for($y=0;$y -lt $image.Height;$y++){$p=$image.GetPixel($x,$y);if($p.R -gt 180 -and $p.G -gt 65 -and $p.G -lt 225 -and $p.B -lt 110){$orange++}}};$image.Dispose();$icon.Dispose();$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($Executable);@{orangePixels=$orange;title=$version.FileDescription}|ConvertTo-Json -Compress`);
    const shell = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Executable', layout.executable], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }));
    assert.ok(shell.orangePixels > 10, 'Shell must extract the approved orange bear icon from the real executable');
    assert.equal(shell.title, 'Icon fixture metadata', 'Other PE resources must be preserved');
  });
