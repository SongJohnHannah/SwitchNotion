/**
 * ytdlp-tool: Download videos from overseas platforms via yt-dlp.
 * 1800+ platforms: YouTube, Twitter/X, Instagram, TikTok, Facebook, etc.
 *
 * Strategy: yt-dlp direct → yt-dlp + CDP cookies → fail
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getCookiesFile } from "./cdp-client.mjs";
import { compressIfNeeded } from "./compressor.mjs";
import { validateNetworkTarget, validateResolvedHost } from "./network-policy.mjs";
import { resolveBin } from "./resolve-bin.mjs";
import { safeFilename } from "./safe-path.mjs";
import { logWarn } from "./utils.mjs";
const execFileAsync = promisify(execFile);
const YTDLP_TIMEOUT_MS = 2_280_000;
const YTDLP_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_OUTPUT_DIR = "/mnt/d/Download";
const YTDLP_RETRYABLE_ERRORS = [
    "http error 403", "sign in", "captcha", "unable to", "not found",
    "login required", "private video", "members-only", "age-restricted",
    "geo-restricted", "http error 429", "rate limit", "temporary ban",
    "access denied", "cloudflare", "please wait", "verify you are human",
    "fresh cookies", "cookies",
];
function resolveYtdlpBin() {
    const resolved = resolveBin("yt-dlp");
    if (resolved)
        return resolved;
    throw new Error("yt-dlp not found. Install: pip install yt-dlp");
}
// yt-dlp format selector allowlist. yt-dlp format strings are short tokens
// like "best", "best[height<=720]", "bv*+ba/b". If user-supplied formats
// ever contain spaces or `--`, yt-dlp's argv parser will treat them as
// flags — so we restrict to the safe subset.
function safeFormatSelector(s) {
    if (s.length > 64)
        return null;
    if (!/^[A-Za-z0-9\[\]<>=*+/,\-_]+$/.test(s))
        return null;
    return s;
}
function detectFileType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if ([".mp3", ".m4a", ".ogg", ".wav", ".flac", ".aac"].includes(ext))
        return "audio";
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext))
        return "image";
    return "video";
}
function isYtdlpRetryableError(stderr) {
    const lower = stderr.toLowerCase();
    return YTDLP_RETRYABLE_ERRORS.some((p) => lower.includes(p));
}
async function runYtdlp(params) {
    const bin = resolveYtdlpBin();
    const baseDir = params.outputDir?.trim() || DEFAULT_OUTPUT_DIR;
    const dateSubDir = new Date().toISOString().slice(0, 10);
    const folderName = params.title ? safeFilename(params.title, 100) : "%(title)s";
    const targetDir = path.join(baseDir, dateSubDir, folderName);
    const args = [
        "--no-warnings", "--encoding", "utf-8", "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2", "--concurrent-fragments", "4", "--abort-on-unavailable-fragments", "--no-playlist", "--prefer-free-formats",
        "-o", path.join(targetDir, "media.%(ext)s"),
        "--print", "after_move:filepath",
    ];
    if (process.env.MEDIAKIT_PROXY_URL)
        args.push("--proxy", process.env.MEDIAKIT_PROXY_URL);
    if (params.cookieFilePath)
        args.splice(1, 0, "--cookies", params.cookieFilePath);
    if (params.format && params.format !== "best") {
        const safe = safeFormatSelector(params.format);
        if (!safe) {
            return { success: false, files: [], stderr: `invalid yt-dlp format selector: ${params.format}` };
        }
        args.push("-f", safe);
    }
    if (params.extractAudio)
        args.push("-x", "--audio-format", "mp3");
    args.push(params.url);
    try {
        const result = await execFileAsync(bin, args, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: YTDLP_MAX_BUFFER });
        const files = [];
        for (const line of (result.stdout?.toString() ?? "").trim().split("\n").filter(Boolean)) {
            const filePath = line.trim();
            if (filePath && fs.existsSync(filePath))
                files.push({ path: filePath, type: detectFileType(filePath) });
        }
        return { success: files.length > 0, files, stderr: result.stderr?.toString() ?? "" };
    }
    catch (err) {
        const error = err;
        if (error.code === "ETIMEDOUT" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            throw new Error(`yt-dlp process error: ${error.code}`, { cause: err });
        }
        return { success: false, files: [], stderr: error.stderr?.toString() ?? "" };
    }
}
export async function ytdlpDownload(params, options) {
    const start = Date.now();
    const stringCheck = validateNetworkTarget(params.url);
    if (stringCheck) {
        return {
            ok: false, method: "none", files: [],
            error: `URL 被安全规则拦截: ${stringCheck}`,
            durationMs: Date.now() - start,
        };
    }
    // DNS-rebinding defense: confirm the hostname still resolves to a
    // public IP at fetch time.
    const resolvedCheck = await validateResolvedHost(params.url);
    if (resolvedCheck) {
        return {
            ok: false, method: "none", files: [],
            error: `URL 被安全规则拦截: ${resolvedCheck}`,
            durationMs: Date.now() - start,
        };
    }
    const initialCookie = await getCookiesFile(options?.browserBaseUrl, params.url);
    let result;
    try {
        result = await runYtdlp({ ...params, cookieFilePath: initialCookie || params.cookieFilePath });
    }
    finally {
        if (initialCookie)
            try {
                fs.unlinkSync(initialCookie);
            }
            catch { }
    }
    if (result.success) {
        await compressIfNeeded(result.files);
        return { ok: true, method: "ytdlp", files: result.files, durationMs: Date.now() - start };
    }
    if (isYtdlpRetryableError(result.stderr)) {
        const cookieFilePath = await getCookiesFile(options?.browserBaseUrl, params.url);
        if (cookieFilePath) {
            result = await runYtdlp({ ...params, cookieFilePath });
            try {
                fs.unlinkSync(cookieFilePath);
            }
            catch { /* ignore */ }
            if (result.success) {
                await compressIfNeeded(result.files);
                return { ok: true, method: "ytdlp", files: result.files, durationMs: Date.now() - start };
            }
        }
    }
    logWarn(`[ytdlp] Download failed for ${params.url}: ${result.stderr.slice(0, 300)}`);
    return {
        ok: false, method: "none", files: [],
        error: `yt-dlp failed: ${result.stderr.slice(0, 500)}`,
        durationMs: Date.now() - start,
    };
}
