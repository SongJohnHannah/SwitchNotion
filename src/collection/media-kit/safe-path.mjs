import path from "node:path";
/**
 * Filename / path sanitization for files we write to disk.
 *
 * Used wherever a path component comes from an untrusted source
 * (user-supplied title, browser-derived page title, remote metadata).
 *
 * Defense:
 *   - Strip path separators and traversal sequences
 *   - Reject absolute paths and Windows drive letters
 *   - Strip control characters
 *   - Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 *   - Truncate to a sane length
 */
const WINDOWS_RESERVED = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
export function safeFilename(name, maxLen = 80) {
    let s = name;
    // Strip control chars first (so subsequent regexes aren't fooled).
    s = s.replace(/[\x00-\x1f\x7f]/g, "");
    // Replace path separators and other Windows-forbidden chars with `_`.
    s = s.replace(/[<>:"/\\|?*]/g, "_");
    // Reject absolute paths and Windows drive letters.
    // After the replace above, leading slashes/backslashes remain. Strip them
    // and re-attach a single "_" prefix if needed.
    s = s.replace(/^[\\/]+/, "");
    // Collapse traversal sequences: .., ..., .... (any number of dots ≥ 2)
    s = s.replace(/\.{2,}/g, "_");
    // Collapse runs of underscores.
    s = s.replace(/_+/g, "_");
    // Strip leading/trailing underscores and dots (Windows strips trailing dots).
    s = s.replace(/^[_.\s]+|[_.\s]+$/g, "");
    // Reject Windows reserved device names (case-insensitive). Windows
    // treats CON.txt / COM1.log as the device itself, regardless of
    // extension. Check the stem (before the first dot).
    const stem = s.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED.has(stem))
        s = "_" + s;
    // Truncate.
    if (s.length > maxLen)
        s = s.slice(0, maxLen).replace(/[_.\s]+$/g, "");
    return s || "untitled";
}
/**
 * Joins `baseDir` and a sanitized `name`, refusing anything that would
 * escape `baseDir`. Returns null if the path is unsafe.
 */
export function safeJoinPath(baseDir, name) {
    const cleaned = safeFilename(name);
    const target = path.resolve(baseDir, cleaned);
    const base = path.resolve(baseDir);
    // path.resolve() normalizes, so this comparison catches "../" escapes.
    if (target !== base && !target.startsWith(base + path.sep))
        return null;
    return target;
}
