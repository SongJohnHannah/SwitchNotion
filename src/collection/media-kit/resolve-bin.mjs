/**
 * Standalone binary resolver — finds executables in trusted system paths.
 * No external dependencies; drops into any Node.js project.
 */
import fs from "node:fs";
import path from "node:path";
/**
 * Resolve the user's home directory as a native OS path.
 * - Linux/macOS: $HOME as-is (e.g. /home/user)
 * - Windows: prefer USERPROFILE, fall back to converted $HOME (which is
 *   often "/c/Users/foo" under MSYS/Git-Bash). "/c/" → "C:\\" so the rest
 *   of resolveBin can join paths natively.
 */
function getHomeDir() {
    if (process.platform === "win32") {
        if (process.env.USERPROFILE)
            return process.env.USERPROFILE;
        const mshome = process.env.HOME || "";
        const m = mshome.match(/^\/([a-zA-Z])(\/.*)?$/);
        if (m)
            return `${m[1].toUpperCase()}:${(m[2] || "\\").replace(/\//g, "\\")}`;
        return mshome || "C:\\Users\\Default";
    }
    return process.env.HOME || "/root";
}
const UNIX_TRUSTED = [
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin",
    "/run/current-system/sw/bin",
];
const WIN_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
function isExecutable(filePath) {
    try {
        if (process.platform === "win32") {
            fs.accessSync(filePath, fs.constants.R_OK);
        }
        else {
            fs.accessSync(filePath, fs.constants.X_OK);
        }
        return true;
    }
    catch {
        return false;
    }
}
const cache = new Map();
/**
 * Resolve a binary name (e.g. "yt-dlp", "ffmpeg") to an absolute path.
 * Searches trusted system directories first, then common package-manager paths.
 * Returns `null` if not found.
 */
export function resolveBin(name, extraDirs) {
    const key = name + (extraDirs ? ":" + extraDirs.join(",") : "");
    const cached = cache.get(key);
    if (cached !== undefined)
        return cached;
    const dirs = [...(process.env.MEDIAKIT_BIN_DIR ? [process.env.MEDIAKIT_BIN_DIR] : []), ...UNIX_TRUSTED, ...(process.env.PATH || "").split(path.delimiter).filter(Boolean), ...(extraDirs ?? [])];
    const home = getHomeDir();
    dirs.push(path.join(home, ".local", "bin"), path.join(home, "bin"));
    for (const dir of dirs) {
        if (process.platform === "win32") {
            for (const ext of WIN_EXTENSIONS) {
                const candidate = path.join(dir, name + ext);
                if (isExecutable(candidate)) {
                    cache.set(key, candidate);
                    return candidate;
                }
            }
        }
        else {
            const candidate = path.join(dir, name);
            if (isExecutable(candidate)) {
                cache.set(key, candidate);
                return candidate;
            }
        }
    }
    cache.set(key, null);
    return null;
}
