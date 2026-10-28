/**
 * Standalone logger — drops into any project without framework deps.
 * Replace `logWarn` / `logInfo` with your own logger if desired.
 */
export function logWarn(msg, extra) {
    if (extra !== undefined)
        console.warn(`[media-kit] ${msg}`, extra);
    else
        console.warn(`[media-kit] ${msg}`);
}
export function logInfo(msg) {
    console.log(`[media-kit] ${msg}`);
}
