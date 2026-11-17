import os from 'node:os';
import path from 'node:path';

export function defaultOutputDirectory({ video = false, platform = process.platform, home = os.homedir() } = {}) {
    if (platform === 'darwin') return path.posix.join(home, 'Downloads', 'NotionSwitch', ...(video ? ['original_video'] : []));
    return video ? '/mnt/d/Download/original_video' : '/mnt/d/Download';
}
