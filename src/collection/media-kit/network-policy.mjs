/**
 * Network policy — SSRF / private-IP guard for all outbound targets.
 *
 * Used by MCP entry points, yt-dlp, and CDP-derived fetches.
 *
 * Rejects:
 *   - Non-http(s) protocols (file, data, ftp, blob, javascript, etc.)
 *   - Loopback (127.0.0.0/8, ::1)
 *   - Private IPv4 (10/8, 172.16/12, 192.168/16, 169.254/16, 0/8,
 *     100.64/10 CGNAT, 224/4 multicast, 240/4 reserved)
 *   - Private IPv6 (fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast)
 *   - IPv4-mapped IPv6 (::ffff:a.b.c.d — unwrap and apply IPv4 rules)
 *   - "localhost" / "localhost.localdomain"
 *
 * Phase-2 (validateResolvedHost): additionally resolves the hostname via
 * dns.lookup() and re-applies the same IP predicates, defeating DNS
 * rebinding attacks where a public-looking hostname resolves to a
 * private IP at fetch time. Callers that bypass Node's URL parser
 * (yt-dlp, ffmpeg) should use validateResolvedHost explicitly.
 */
import { lookup } from "node:dns/promises";
const ALLOWED_PROTOCOLS = ["http:", "https:"];
/**
 * When MEDIAKIT_ALLOW_PRIVATE=1, skip the private-IP / loopback guard.
 * Off by default — keeping SSRF protection tight. Set this only for
 * trusted local dev / debugging against your own services.
 */
function isPrivateNetworkAllowed() {
    const v = process.env.MEDIAKIT_ALLOW_PRIVATE;
    return v === "1" || v === "true" || v === "yes";
}
const PRIVATE_IPV4_PATTERNS = [
    /^127\./, // 127.0.0.0/8 loopback
    /^10\./, // 10.0.0.0/8 private
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 private
    /^192\.168\./, // 192.168.0.0/16 private
    /^169\.254\./, // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
    /^0\./, // 0.0.0.0/8 reserved
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
    /^22[4-9]\./, /^23[0-9]\./, // 224.0.0.0/4 multicast
    /^24[0-9]\./, /^25[0-5]\./, // 240.0.0.0/4 reserved
];
const PRIVATE_HOSTNAMES = new Set([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
]);
function isPrivateIPv4(host) {
    return PRIVATE_IPV4_PATTERNS.some((r) => r.test(host));
}
function isPrivateIPv6(host) {
    // Node's URL parser keeps IPv6 brackets in hostname (e.g. "[::1]") and
    // also rewrites IPv4-mapped IPv6 to its hex form
    // (e.g. "::ffff:127.0.0.1" → "::ffff:7f00:1").
    const stripped = host.replace(/^\[|\]$/g, "");
    if (/^::1$/i.test(stripped))
        return true;
    if (/^fc[0-9a-f]{2}:/i.test(stripped))
        return true; // fc00::/7 ULA
    if (/^fd[0-9a-f]{2}:/i.test(stripped))
        return true;
    if (/^fe[89ab][0-9a-f]:/i.test(stripped))
        return true; // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/i.test(stripped))
        return true; // ff00::/8 multicast
    // IPv4-mapped IPv6 — Node normalizes "::ffff:a.b.c.d" → "::ffff:HHHH:HHHH"
    // (low 32 bits encoded as two 16-bit hex groups). Anything with the
    // ::ffff: prefix is suspect for outbound HTTP, so block unconditionally
    // rather than trying to decode and re-check against IPv4 private ranges.
    if (/^::ffff:/i.test(stripped))
        return true;
    return false;
}
function isPrivateHost(host) {
    if (!host)
        return true; // reject empty hostname
    if (PRIVATE_HOSTNAMES.has(host.toLowerCase()))
        return true;
    // Heuristic: any ':' → IPv6, otherwise IPv4 / hostname
    if (host.includes(":"))
        return isPrivateIPv6(host);
    // Reject bare IPv4 literals that fall in private ranges
    if (/^[0-9.]+$/.test(host))
        return isPrivateIPv4(host);
    // Public hostname (e.g. example.com) — pass through; DNS resolution may
    // still be checked at the network layer (P0-C DNS rebinding follow-up).
    return false;
}
/**
 * Returns null if the URL is safe to fetch, otherwise a human-readable
 * rejection reason.
 */
export function validateNetworkTarget(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return "无效 URL";
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
        return `不允许的协议 ${parsed.protocol}（仅允许 http/https）`;
    }
    const host = parsed.hostname;
    if (!host)
        return "URL 必须包含主机名";
    if (!isPrivateNetworkAllowed() && isPrivateHost(host)) {
        return `不允许访问内网地址 ${host}（如需访问本机调试服务，请设置环境变量 MEDIAKIT_ALLOW_PRIVATE=1）`;
    }
    return null;
}
/**
 * DNS-resolved SSRF guard. Resolves the URL's hostname via dns.lookup()
 * and re-applies the same IP predicates to the resolved IP.
 *
 * This catches the case where a hostname LOOKS public (e.g. "evil.com")
 * but resolves to a private IP (127.0.0.1, 169.254.169.254, etc.) —
 * including DNS rebinding attacks where the first lookup returns public
 * and a later lookup returns private. For strongest defense against
 * rebinding, callers should use this at every hop (initial URL + every
 * redirect).
 *
 * Returns null if safe, or a rejection reason.
 */
export async function validateResolvedHost(url) {
    const initial = validateNetworkTarget(url);
    if (initial)
        return initial;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return "无效 URL";
    }
    const host = parsed.hostname;
    if (!host)
        return "URL 必须包含主机名";
    // If the hostname is itself a literal IP, no DNS resolution needed —
    // the string check above already covered it.
    if (/^[0-9.]+$/.test(host) || host.includes(":"))
        return null;
    let resolved;
    try {
        resolved = await lookup(host);
    }
    catch {
        return `DNS 解析失败 ${host}`;
    }
    // Check the resolved IP (handles IPv4 literal and IPv4-mapped IPv6 form
    // returned by Node's dns.lookup on dual-stack systems).
    if (isPrivateIPv4(resolved.address)) {
        return `不允许访问内网地址 ${host} (resolved ${resolved.address})`;
    }
    // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1) — check via IPv6 branch.
    if (resolved.family === 6 && isPrivateIPv6(resolved.address)) {
        return `不允许访问内网地址 ${host} (resolved ${resolved.address})`;
    }
    return null;
}
