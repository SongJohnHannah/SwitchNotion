import { randomUUID } from "node:crypto";
/**
 * Chrome DevTools Protocol client — standalone, no framework dependencies.
 *
 * Handles:
 * - Chrome auto-start + profile cleanup
 * - CDP HTTP endpoints (bypass proxy for localhost)
 * - Tab open/close + orphan cleanup
 * - Cookie extraction + Netscape cookie file generation
 * - JS evaluation (Runtime.evaluate)
 * - Video CDN URL interception + download through proxy
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateNetworkTarget, validateResolvedHost } from "./network-policy.mjs";
import { safeFilename } from "./safe-path.mjs";
import { logWarn } from "./utils.mjs";
const execFileAsync = promisify(execFile);
const COOKIE_CACHE_TTL_MS = 30 * 60 * 1000;
const CHROME_READY_POLL_MS = 1000;
const CHROME_READY_TIMEOUT_MS = 15_000;
// PowerShell helper script for finding Chrome PIDs by user-data-dir.
// Uses a declared parameter so PowerShell does parameter binding (NOT
// string interpolation), preventing command injection via crafted
// userDataDir values. Written to a fixed path under os.tmpdir() and
// reused across calls.
const PS_FIND_CHROME_SCRIPT = path.join(os.tmpdir(), "media-kit-find-chrome.ps1");
const PS_FIND_CHROME_BODY = [
    "param([string]$UserDataDir)",
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" |',
    "  Where-Object { $_.CommandLine -like \"*$UserDataDir*\" } |",
    "  Select-Object -ExpandProperty ProcessId",
    "",
].join("\n");
let psScriptWritten = false;
async function ensurePsScriptWritten() {
    if (psScriptWritten)
        return;
    try {
        await fs.promises.writeFile(PS_FIND_CHROME_SCRIPT, PS_FIND_CHROME_BODY, { mode: 0o600 });
        psScriptWritten = true;
    }
    catch { /* best-effort */ }
}
// ── Chrome process management ──
function findChromeExe(config) {
    // 1. Config explicit path (highest priority)
    if (config?.chromeExecutablePath) {
        try {
            fs.accessSync(config.chromeExecutablePath, fs.constants.X_OK);
            return config.chromeExecutablePath;
        }
        catch {
            /* fall through */
        }
    }
    // 2. Environment variable
    const envPath = process.env.CHROME_PATH?.trim();
    if (envPath) {
        try {
            fs.accessSync(envPath, fs.constants.X_OK);
            return envPath;
        }
        catch {
            /* configured path not accessible, fall through */
        }
    }
    // 3. Known locations (Windows Chrome first for WSL2 login sessions)
    const candidates = [
        // Windows (native)
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        // Windows (WSL2)
        "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
        "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
        // macOS
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        // Linux
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/microsoft-edge",
        "/usr/bin/brave-browser",
        "/usr/bin/brave",
    ];
    for (const c of candidates) {
        try {
            fs.accessSync(c, fs.constants.X_OK);
            return c;
        }
        catch {
            continue;
        }
    }
    return null;
}
function isWindowsChromePath(chromePath) {
    return chromePath.startsWith("/mnt/") || /^[A-Za-z]:[\\/]/.test(chromePath);
}
function resolveChromeUserDataDir(config) {
    if (config?.chromeUserDataDir) {
        fs.mkdirSync(config.chromeUserDataDir, { recursive: true });
        return config.chromeUserDataDir;
    }
    // WSL2: prefer Windows-side user-data-dir (Windows Chrome needs a Win path)
    if (isWsl()) {
        const winUser = findWslWindowsUser();
        if (winUser) {
            const winDir = `/mnt/c/Users/${winUser}/.media-kit/browser/user-data`;
            fs.mkdirSync(winDir, { recursive: true });
            return winDir;
        }
    }
    // Linux fallback: ~/.media-kit/browser/user-data
    const base = process.env.HOME || "/root";
    const dir = path.join(base, ".media-kit", "browser", "user-data");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function isWsl() {
    try {
        return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
    }
    catch {
        return false;
    }
}
/**
 * IP that WSL2 uses to reach the Windows host (the eth0 IP visible from
 * the Windows side). Parsed from /etc/resolv.conf. Returns null when not
 * in WSL2 or when resolv.conf is unreadable.
 *
 * Security: we use this to bind Windows Chrome's CDP endpoint only to the
 * address WSL2 actually needs — never 0.0.0.0 — so the CDP socket isn't
 * reachable from other machines on the LAN.
 */
function getWslHostIp() {
    if (!isWsl())
        return null;
    try {
        const resolv = fs.readFileSync("/etc/resolv.conf", "utf-8");
        const m = resolv.match(/^nameserver\s+(\S+)/m);
        return m ? m[1] : null;
    }
    catch {
        return null;
    }
}
function findWslWindowsUser() {
    try {
        const users = fs.readdirSync("/mnt/c/Users");
        for (const u of users) {
            if (["Public", "Default", "Default User", "All Users", "desktop.ini"].includes(u))
                continue;
            if (u.startsWith("defaultuser"))
                continue;
            if (fs.existsSync(`/mnt/c/Users/${u}/NTUSER.DAT`))
                return u;
        }
    }
    catch { /* not accessible */ }
    return null;
}
function cleanChromeProfile(userDataDir) {
    for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        try {
            fs.unlinkSync(path.join(userDataDir, name));
        }
        catch { /* not present */ }
    }
    const prefsPath = path.join(userDataDir, "Default", "Preferences");
    try {
        if (fs.existsSync(prefsPath)) {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
            prefs.exit_type = "Normal";
            prefs.exited_cleanly = true;
            if (typeof prefs.profile === "object" && prefs.profile !== null) {
                prefs.profile.exit_type = "Normal";
                prefs.profile.exited_cleanly = true;
            }
            fs.writeFileSync(prefsPath, JSON.stringify(prefs));
        }
    }
    catch { /* best-effort */ }
    const localStatePath = path.join(userDataDir, "Local State");
    try {
        if (fs.existsSync(localStatePath)) {
            const localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
            const profile = localState.profile;
            if (typeof profile === "object" && profile !== null) {
                if (profile.exit_type === "Crashed" || profile.exit_type === "SessionExited") {
                    profile.exit_type = "Normal";
                    fs.writeFileSync(localStatePath, JSON.stringify(localState));
                }
            }
        }
    }
    catch { /* best-effort */ }
}
/** Check if Chrome CDP is already listening on the given port */
export async function isCdpReady(cdpPort) {
    try {
        const res = await cdpFetch(`http://127.0.0.1:${cdpPort}/json/version`);
        return res.ok;
    }
    catch {
        return false;
    }
}
/** Kill Chrome processes launched with a specific user-data-dir (WSL2 or Linux) */
async function killChromeByUserDataDir(userDataDir) {
    try {
        if (process.platform === "linux" && fs.existsSync("/proc/version")) {
            const version = fs.readFileSync("/proc/version", "utf-8");
            if (version.toLowerCase().includes("microsoft")) {
                // WSL2: find Chrome PIDs that match our user-data-dir, then taskkill those only.
                // Use a param() script file (not -Command + interpolation) so the
                // userDataDir is bound as a string parameter, not parsed as PS code.
                try {
                    await ensurePsScriptWritten();
                    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-File", PS_FIND_CHROME_SCRIPT, "-UserDataDir", userDataDir], { timeout: 10000 });
                    const pids = stdout
                        .split(/\r?\n/)
                        .map((l) => parseInt(l.trim(), 10))
                        .filter((p) => !isNaN(p) && p > 0);
                    for (const pid of pids) {
                        try {
                            await execFileAsync("/mnt/c/Windows/System32/taskkill.exe", ["/F", "/PID", String(pid)], { timeout: 5000 });
                        }
                        catch { /* ignore */ }
                    }
                }
                catch { /* ignore */ }
                return;
            }
        }
        // Linux: pkill with --full to match user-data-dir in the command line
        const dirBasename = path.basename(userDataDir);
        try {
            await execFileAsync("pkill", ["-9", "-f", `chrome.*${dirBasename}`]);
        }
        catch { /* no match */ }
        try {
            await execFileAsync("pkill", ["-9", "-f", `chromium.*${dirBasename}`]);
        }
        catch { /* no match */ }
    }
    catch { /* ignore */ }
}
/**
 * Ensure Chrome is running with CDP enabled.
 * - If CDP port is alive → reuse (don't kill, keep cookies/sessions)
 * - If CDP port is temporarily unresponsive → retry up to 3 times with backoff
 * - If truly dead → restart Chrome for this profile only (preserve disk cookies)
 */
export async function ensureChromeRunning(cdpPort, config) {
    if (await isCdpReady(cdpPort))
        return true;
    // Retry CDP check a few times before killing — Chrome may be briefly unresponsive
    for (let attempt = 1; attempt <= 3; attempt++) {
        logWarn(`[cdp-client] CDP not responding on port ${cdpPort}; retry ${attempt}/3 in ${attempt * 2}s`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
        if (await isCdpReady(cdpPort))
            return true;
    }
    logWarn("[cdp-client] CDP still not responding; restarting Chrome for this profile only");
    const userDataDir = resolveChromeUserDataDir(config);
    // Never kill another browser session while preparing the collector.
    await new Promise((r) => setTimeout(r, 3000));
    const chromeExe = findChromeExe(config);
    if (!chromeExe) {
        logWarn("[cdp-client] ⚠️ 没有找到可用的浏览器 (Chrome/Edge/Brave/Chromium)。请安装 Chrome 或设置 CHROME_PATH 环境变量指定浏览器路径");
        return false;
    }
    // Keep the persistent browser profile intact.
    let chromeUserDataDir = userDataDir;
    if (userDataDir.startsWith("/mnt/")) {
        const driveLetter = userDataDir.charAt(5).toUpperCase();
        chromeUserDataDir = userDataDir.slice(6).replace(/\//g, "\\");
        chromeUserDataDir = `${driveLetter}:${chromeUserDataDir}`;
    }
    const isWindowsExe = isWindowsChromePath(chromeExe);
    const args = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeUserDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-features=Translate,MediaRouter",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--disable-dev-shm-usage",
        "--disable-infobars",
        "--disable-automation",
        "--no-startup-window",
        ...(config?.chromeExtraArgs ?? []),
    ];
    if (isWindowsExe && isWsl()) {
        // Windows Chrome from WSL2: bind ONLY to the IP WSL2 uses to reach the
        // Windows host. Never 0.0.0.0 — that would expose CDP on the LAN.
        const hostIp = getWslHostIp();
        if (hostIp) {
            args.unshift(`--remote-debugging-address=${hostIp}`);
            logWarn(`[cdp-client] Windows Chrome CDP binding to WSL2 host IP ${hostIp} (narrow, not 0.0.0.0)`);
        }
        else {
            // Refuse to fall back to 0.0.0.0: if we can't determine the WSL2
            // host IP, the user has to fix their network setup rather than
            // silently leak CDP onto every interface.
            logWarn("[cdp-client] Windows Chrome in WSL2 but no host IP in /etc/resolv.conf; binding 127.0.0.1 only (WSL2→Chrome may not reach CDP; check resolv.conf)");
        }
    }
    else if (isWindowsExe) {
        // Native Windows process: Chrome's default 127.0.0.1 binding is fine.
    }
    else if (process.platform !== "darwin") {
        // Linux Chrome in WSL2/Docker: run headless (no display needed)
        args.push("--headless=new");
    }
    // Only set proxy when explicitly configured; no hardcoded fallback
    if (config?.proxyUrl) {
        args.push(`--proxy-server=${config.proxyUrl}`);
    }
    spawn(chromeExe, args, { stdio: "ignore", detached: true }).unref();
    // Wait for CDP to become ready
    const deadline = Date.now() + CHROME_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, CHROME_READY_POLL_MS));
        if (await isCdpReady(cdpPort)) {
            // Open a persistent keeper tab so Chrome stays alive when working tabs close
            try {
                await cdpFetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`);
            }
            catch { /* ignore */ }
            return true;
        }
    }
    logWarn(`[cdp-client] Chrome CDP did not become ready on port ${cdpPort} within ${CHROME_READY_TIMEOUT_MS}ms`);
    return false;
}
// ── CDP HTTP helpers (bypass proxy for localhost) ──
/** fetch() that bypasses HTTP_PROXY for localhost CDP calls */
export function cdpFetch(url, init) {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        return fetch(url, init);
    }
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: init?.method || "GET",
            headers: init?.headers,
            agent: new http.Agent(),
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");
                resolve(new Response(body, { status: res.statusCode ?? 200, headers: res.headers }));
            });
        });
        req.on("error", reject);
        req.end();
    });
}
/** Open a new CDP browser tab */
export async function cdpOpenTab(browserBaseUrl, targetUrl) {
    const res = await cdpFetch(`${browserBaseUrl}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
    if (!res.ok)
        return null;
    const tabInfo = (await res.json());
    const tabId = tabInfo.id ?? "";
    const wsUrl = tabInfo.webSocketDebuggerUrl ?? "";
    return tabId && wsUrl ? { tabId, wsUrl } : null;
}
/** Close a CDP browser tab */
export async function cdpCloseTab(browserBaseUrl, tabId) {
    try {
        await cdpFetch(`${browserBaseUrl}/json/close/${tabId}`);
    }
    catch { /* ignore */ }
}
/** Close all remaining page/worker tabs (orphaned after closing the main tab) */
export async function closeOrphanedTabs(browserBaseUrl) {
    try {
        const res = await cdpFetch(`${browserBaseUrl}/json/list`);
        if (!res.ok)
            return;
        const tabs = (await res.json());
        for (const tab of tabs) {
            // Only close worker/service_worker orphans — never close page tabs
            // (user may have manual tabs open, and closing all pages can kill Chrome)
            if (tab.type === "worker" || tab.type === "service_worker") {
                await cdpCloseTab(browserBaseUrl, tab.id);
            }
        }
    }
    catch { /* ignore */ }
}
/** Keep Chrome process alive: if no page tabs remain, open about:blank */
async function keepBrowserAlive(browserBaseUrl) {
    try {
        const res = await cdpFetch(`${browserBaseUrl}/json/list`);
        if (!res.ok)
            return;
        const tabs = (await res.json());
        const hasPage = tabs.some((t) => t.type === "page");
        if (!hasPage) {
            await cdpFetch(`${browserBaseUrl}/json/new?about:blank`, { method: "PUT" });
        }
    }
    catch { /* ignore */ }
}
const cookieCache = new Map();
/** Get cookies for a URL via CDP (with 30min cache) */
export async function cdpGetCookies(browserBaseUrl, url) {
    const domain = new URL(url).hostname;
    if (!domain)
        return "";
    const cached = cookieCache.get(domain);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.cookies;
    }
    let tabId = "";
    let wsUrl = "";
    try {
        const tab = await cdpOpenTab(browserBaseUrl, url);
        if (!tab) {
            logWarn("[cdp-client] CDP cookie tab open failed");
            return "";
        }
        tabId = tab.tabId;
        wsUrl = tab.wsUrl;
    }
    catch (err) {
        logWarn(`[cdp-client] CDP cookie tab error: ${String(err)}`);
        return "";
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const cookies = await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); resolve(""); }, 10_000);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ id: 1, method: "Network.getCookies", params: { urls: [url] } }));
        });
        ws.addEventListener("message", (event) => {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
            if (msg.id === 1 && msg.result?.cookies) {
                clearTimeout(timer);
                ws.close();
                resolve(msg.result.cookies.map((c) => `${c.name}=${c.value}`).join("; "));
            }
        });
        ws.addEventListener("error", () => { clearTimeout(timer); resolve(""); });
    });
    await cdpCloseTab(browserBaseUrl, tabId);
    await keepBrowserAlive(browserBaseUrl);
    if (cookies) {
        cookieCache.set(domain, { cookies, domain, expiresAt: Date.now() + COOKIE_CACHE_TTL_MS });
    }
    return cookies;
}
/** Write cookie header string to a Netscape cookie file for yt-dlp */
export async function writeCookiesToFile(cookies, domain) {
    if (!cookies)
        return null;
    const tmpDir = process.env.MEDIAKIT_COOKIE_DIR || os.tmpdir();
    const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "_");
    const cookiePath = path.join(tmpDir, `switch-notion-cookies-${safeDomain}-${randomUUID()}.txt`);
    const lines = [
        "# Netscape HTTP Cookie File",
        "# This is a generated file!  Do not edit.",
        "",
    ];
    const cookieDomain = domain.startsWith(".") ? domain : `.${domain}`;
    for (const pair of cookies.split("; ")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx < 0)
            continue;
        const name = pair.slice(0, eqIdx);
        const value = pair.slice(eqIdx + 1);
        lines.push(`${cookieDomain}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
    }
    try {
        await fs.promises.writeFile(cookiePath, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
        return cookiePath;
    }
    catch {
        return null;
    }
}
/** Get cookies and write to file — convenience wrapper */
export async function getCookiesFile(browserBaseUrl, url) {
    if (!browserBaseUrl)
        return undefined;
    try {
        const domain = new URL(url).hostname;
        const cookieHeader = await cdpGetCookies(browserBaseUrl, url);
        if (cookieHeader && domain) {
            return (await writeCookiesToFile(cookieHeader, domain)) ?? undefined;
        }
    }
    catch { /* ignore */ }
    return undefined;
}
// ── JS Evaluation ──
/** Evaluate a JS expression in a CDP tab */
export async function cdpEvaluate(wsUrl, expression, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const id = 1;
        const timer = setTimeout(() => { ws.close(); reject(new Error("CDP evaluate timeout")); }, timeoutMs);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        });
        ws.addEventListener("message", (event) => {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
            if (msg.id === id) {
                clearTimeout(timer);
                ws.close();
                resolve(msg.result?.result?.value ?? "");
            }
        });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket error")); });
    });
}
// ── Video CDN interception + download ──
function isVideoUrl(reqUrl) {
    return ((reqUrl.includes("douyinvod") || reqUrl.includes("video/tos") ||
        (reqUrl.includes("sns-video") && reqUrl.includes(".mp4")) ||
        reqUrl.includes("/stream/")) &&
        !reqUrl.includes(".js") && !reqUrl.includes(".css") && !reqUrl.includes(".json"));
}
function isAudioUrl(reqUrl) {
    if (reqUrl.includes(".js") || reqUrl.includes(".css") || reqUrl.includes(".json"))
        return false;
    if (/media-audio-|mime_type=audio|\.m4a(?:\?|$)/i.test(reqUrl) || reqUrl.includes("byteaudio"))
        return true;
    if (reqUrl.includes("/audio/") && (reqUrl.includes(".m4a") || reqUrl.includes(".aac")))
        return true;
    if (reqUrl.includes("douyinvod") && reqUrl.includes("/audio/"))
        return true;
    return false;
}
/** Open a URL in CDP, intercept Network requests to capture video+audio CDN URLs, then download */
export async function cdpExtractAndDownloadVideo(browserBaseUrl, url, outputDir, filename, proxyUrl) {
    let tabId = "";
    let wsUrl = "";
    try {
        const tab = await cdpOpenTab(browserBaseUrl, url);
        if (!tab)
            return { ok: false, error: "CDP open tab failed" };
        tabId = tab.tabId;
        wsUrl = tab.wsUrl;
    }
    catch (err) {
        return { ok: false, error: `CDP open tab error: ${String(err)}` };
    }
    const videoUrls = [];
    const audioUrls = [];
    let pageTitle = "";
    let loginRedirect = null;
    const result = await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        let msgId = 0;
        const timer = setTimeout(() => {
            ws.close();
            resolve({ videoUrls, audioUrls, title: pageTitle, loginRedirect: loginRedirect ?? undefined });
        }, 25_000);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ id: ++msgId, method: "Network.enable" }));
        });
        ws.addEventListener("message", (event) => {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
            if (msg.method === "Network.requestWillBeSent") {
                const reqUrl = msg.params?.request?.url || "";
                if (isVideoUrl(reqUrl) && !videoUrls.some((u) => u.split("?")[0] === reqUrl.split("?")[0])) {
                    videoUrls.push(reqUrl);
                }
                if (isAudioUrl(reqUrl) && !audioUrls.some((u) => u.split("?")[0] === reqUrl.split("?")[0])) {
                    audioUrls.push(reqUrl);
                }
            }
            // Detect login redirects
            if (msg.method === "Network.requestWillBeSent" && msg.params?.request?.url) {
                const navUrl = msg.params.request.url;
                if (navUrl !== url && (navUrl.includes("/login") || navUrl.includes("/signin") || navUrl.includes("/auth"))) {
                    loginRedirect = navUrl;
                    logWarn(`[cdp-client] Page redirected to login: ${navUrl.slice(0, 100)}`);
                }
            }
            // After Network.enable, wait then extract title
            if (msg.id === 1) {
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        id: ++msgId,
                        method: "Runtime.evaluate",
                        params: {
                            expression: `
                (function() {
                  var title = '';
                  document.querySelectorAll('[data-e2e=video-desc], h1, .title, meta[property="og:title"]').forEach(function(el) {
                    var t = el.getAttribute('content') || el.textContent || '';
                    t = t.trim();
                    if (t.length > title.length) title = t;
                  });
                  return title || document.title || '';
                })()
              `,
                            returnByValue: true,
                        },
                    }));
                }, 10_000);
            }
            if (msg.id === 2) {
                pageTitle = msg.params?.result?.result?.value || "";
            }
            // After title, check performance entries for missed video+audio URLs
            if (msg.id === 2) {
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        id: ++msgId,
                        method: "Runtime.evaluate",
                        params: {
                            expression: `
                (function() {
                  var result = { video: [], audio: [] };
                  if (performance.getEntriesByType) {
                    performance.getEntriesByType('resource').forEach(function(e) {
                      if (e.name.includes('douyinvod') || e.name.includes('video/tos')) result.video.push(e.name);
                      if (e.name.includes('media-audio-') || e.name.includes('mime_type=audio') || e.name.includes('byteaudio') || (e.name.includes('/audio/') && (e.name.includes('.m4a') || e.name.includes('.aac')))) result.audio.push(e.name);
                    });
                  }
                  return JSON.stringify(result);
                })()
              `,
                            returnByValue: true,
                        },
                    }));
                }, 1000);
            }
            if (msg.id === 3) {
                try {
                    const perfResult = JSON.parse(msg.params?.result?.result?.value || '{"video":[],"audio":[]}');
                    for (const u of perfResult.video) {
                        if (!videoUrls.some((v) => v.split("?")[0] === u.split("?")[0])) {
                            videoUrls.push(u);
                        }
                    }
                    for (const u of perfResult.audio) {
                        if (!audioUrls.some((v) => v.split("?")[0] === u.split("?")[0])) {
                            audioUrls.push(u);
                        }
                    }
                }
                catch { /* ignore */ }
                clearTimeout(timer);
                ws.close();
                resolve({ videoUrls, audioUrls, title: pageTitle, loginRedirect: loginRedirect ?? undefined });
            }
        });
        ws.addEventListener("error", () => {
            clearTimeout(timer);
            resolve({ videoUrls, audioUrls, title: pageTitle, loginRedirect: loginRedirect ?? undefined });
        });
    });
    await cdpCloseTab(browserBaseUrl, tabId);
    await keepBrowserAlive(browserBaseUrl);
    if (result.videoUrls.length === 0) {
        const loginHint = result.loginRedirect
            ? ` Page redirected to login (${result.loginRedirect.slice(0, 80)}). Browser is kept open — please log in via Chrome and retry.`
            : "";
        return { ok: false, error: `No video CDN URLs captured from page.${loginHint}` };
    }
    const videoUrl = result.videoUrls[0];
    const safeTitle = safeFilename(result.title || filename || "video", 80);
    const filePath = path.join(outputDir, `${safeTitle}.mp4`);
    await fs.promises.mkdir(outputDir, { recursive: true });
    const downloaded = await downloadThroughProxy(videoUrl, filePath, proxyUrl, url);
    if (!downloaded) {
        return { ok: false, error: "Video download failed" };
    }
    let audioFilePath;
    if (result.audioUrls.length > 0) {
        const audioUrl = result.audioUrls[0];
        const audioExt = audioUrl.includes(".m4a") ? ".m4a" : audioUrl.includes(".aac") ? ".aac" : ".m4a";
        const audioPath = path.join(outputDir, `${safeTitle}_audio${audioExt}`);
        const audioDownloaded = await downloadThroughProxy(audioUrl, audioPath, proxyUrl, url);
        if (audioDownloaded) {
            audioFilePath = audioPath;
        }
    }
    return {
        ok: true,
        filePath,
        audioFilePath,
        warning: result.loginRedirect
            ? `Page was redirected to login (${result.loginRedirect.slice(0, 80)}). Download succeeded using existing session cookies.`
            : undefined,
    };
}
// ── File download through HTTP proxy ──
async function downloadThroughProxy(fileUrl, destPath, proxyUrl, referer) {
    // SSRF guard: CDN URLs are browser-observed, not user-typed, but a
    // malicious page can still cause Network.requestWillBeSent to surface
    // http://127.0.0.1 or similar. Re-validate before the actual fetch.
    if (validateNetworkTarget(fileUrl))
        return false;
    // DNS rebinding defense: re-check that the host still resolves to a
    // public IP at the moment of fetch.
    if (await validateResolvedHost(fileUrl))
        return false;
    try {
        if (proxyUrl) {
            const proxyParsed = new URL(proxyUrl);
            const fileParsed = new URL(fileUrl);
            const body = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: proxyParsed.hostname,
                    port: proxyParsed.port,
                    path: fileUrl,
                    method: "GET",
                    headers: {
                        Host: fileParsed.hostname,
                        "User-Agent": "Mozilla/5.0",
                        Referer: referer || "",
                    },
                }, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        downloadFileDirect(res.headers.location, destPath, referer).then(() => resolve(Buffer.alloc(0))).catch(reject);
                        return;
                    }
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => resolve(Buffer.concat(chunks)));
                });
                req.on("error", reject);
                req.setTimeout(120_000, () => { req.destroy(); reject(new Error("download timeout")); });
                req.end();
            });
            if (body.length > 1000) {
                await fs.promises.writeFile(destPath, body);
                return true;
            }
            // Redirect handler may have already written the file
            try {
                const stat = await fs.promises.stat(destPath);
                if (stat.size > 1000)
                    return true;
            }
            catch { /* not written yet */ }
        }
        return downloadFileDirect(fileUrl, destPath, referer);
    }
    catch {
        return false;
    }
}
async function downloadFileDirect(url, destPath, referer) {
    if (validateNetworkTarget(url))
        return false;
    if (await validateResolvedHost(url))
        return false;
    try {
        const headers = { "User-Agent": "Mozilla/5.0" };
        if (referer)
            headers.Referer = referer;
        const resp = await fetch(url, { redirect: "follow", headers });
        if (!resp.ok)
            return false;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 1000)
            return false;
        await fs.promises.writeFile(destPath, buf);
        return true;
    }
    catch {
        return false;
    }
}
