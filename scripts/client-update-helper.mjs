import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import clientModule from '../src/client-update.cjs';
import { runProjectTests } from './client-tests.mjs';
import { launchLock } from './launch-lock.mjs';

function startProject(project, root, checking) {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(path.join(root, 'client-update-launch.log'), 'a', 0o600);
    // Always use a fresh Node process: modules imported before the Git update
    // must not keep the old updater cached while preparing the new code.
    const child = spawn(process.execPath, [path.join(project, 'scripts/start-desktop.mjs')], { cwd: project, windowsHide: true,
      env: { ...process.env, NOTION_SWITCH_ROOT: root, NOTION_SWITCH_PROJECT: project,
        NOTION_SWITCH_FORCE_UPDATE: '0', NOTION_SWITCH_OPEN_SETTINGS: '1', NOTION_SWITCH_UPDATE_VIEW: '1', NOTION_SWITCH_CLIENT_UPDATE: checking ? '1' : '0' },
      stdio: ['ignore', log, log] });
    fs.closeSync(log);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('新代码未通过启动检查。')));
  });
}
export async function applyClientUpdate({ project, root, plan, client = new clientModule.ClientUpdate({ projectDirectory: project, root }), start = checking => startProject(project, root, checking), runTests = runProjectTests }) {
  let changed = false, release;
  try {
    release = launchLock(root);
    await client.apply(plan); changed = true;
    client.save('testing', '正在运行更新后的测试…', plan, 60);
    const tests = await runTests({ project, root });
    if (tests.missing) throw Object.assign(Error('更新缺少测试文件，已回退。'), { testsFailed: true });
    if (!tests.ok) throw Object.assign(Error(tests.timedOut ? '更新后的测试超时，已回退。' : '更新后的测试未通过，已回退。'), { testsFailed: true });
    client.save('applying', '测试通过，正在重启并检查…', plan, 85);
    release(); release = null;
    await start(true);
    client.save('applied', 'Switch Notion 已更新至 ' + plan.after.slice(0, 7) + '，测试通过，新代码已接入。', plan, 100);
    return true;
  } catch (error) {
    release?.();
    if (changed) {
      try { await client.restore(plan); }
      catch { client.save('blocked', '新代码测试或启动未完成，且项目已有其他改动，未覆盖本地代码。请检查项目后重新启动。', plan); return false; }
      if (error.testsFailed) client.save('restored', error.message + '详情见 client-update-tests.log。', plan);
    } else client.save('blocked', error.message, plan);
    try { await start(false); } catch { client.save('blocked', '更新未完成，请重新打开 Switch Notion；本机资料已保留。', plan); }
    return false;
  }
}
