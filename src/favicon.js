/**
 * favicon 抓取核心逻辑
 *
 * 功能：
 * - 同 Origin 进行中请求合并（inFlight Map）
 * - 成功缓存 + 失败短缓存
 * - 顺序抓取（先 HTML 解析声明图标，再 /favicon.ico，再聚合源兜底）
 * - 总时间预算
 * - 结构化错误
 * - SSRF 防护（保持不变）
 * - 与 limiter 和 runtime-metrics 集成
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { ServiceError, classifyError } from "./error.js";
import { limiter } from "./limiter.js";
import { runtimeMetrics } from "./runtime-metrics.js";
import { readPersistentCache, writePersistentCache, deletePersistentCache } from "./persistent-cache.js";

// ── 环境变量 ──────────────────────────────────────────────
const TOTAL_TIMEOUT_MS = parseInt(process.env.FAVICON_TOTAL_TIMEOUT_MS || "9000", 10);
const AGGREGATOR_HEDGE_MS = parseInt(process.env.FAVICON_AGGREGATOR_HEDGE_MS || "1000", 10);
const SECOND_AGGREGATOR_HEDGE_MS = parseInt(process.env.FAVICON_SECOND_AGGREGATOR_HEDGE_MS || "1500", 10);
const SUCCESS_CACHE_TTL_MS = parseInt(process.env.FAVICON_SUCCESS_CACHE_TTL_MS || "3600000", 10);
const SUCCESS_CACHE_MAX = parseInt(process.env.FAVICON_SUCCESS_CACHE_MAX || "1000", 10);
const FAIL_CACHE_TTL_MS = parseInt(process.env.FAVICON_FAIL_CACHE_TTL_MS || "60000", 10);

// 抓取大小限制（保持不变）
const MAX_FAVICON_SIZE = 5 * 1024 * 1024;
const MAX_HTML_SIZE = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// 聚合源 placeholder 哈希
const AGGREGATOR_PLACEHOLDER_HASHES = new Set([
  "ebfb7deb2782f551f757a9077203194dedeb132c091005204135905134e4b0e7",
]);

// ── 缓存 ──────────────────────────────────────────────────
const successCache = new Map();
const failureCache = new Map();
const inFlightOrigins = new Map(); // originKey → Promise

// ── 失败缓存 TTL ──────────────────────────────────────────
const FAIL_TTL = {
  ICON_NOT_FOUND: 6 * 3600_000,
  INVALID_URL:    3600_000,
  PRIVATE_ADDRESS: 3600_000,
  DNS_ERROR:      60_000,
  UPSTREAM_TIMEOUT: 30_000,
  UPSTREAM_ERROR: 30_000,
  QUEUE_FULL:     0,
  INTERNAL_ERROR: 10_000,
};

function getFailTtl(code) {
  return FAIL_TTL[code] !== undefined ? FAIL_TTL[code] : FAIL_CACHE_TTL_MS;
}

function cachePrune(map, maxSize) {
  if (map.size < maxSize) return;
  const oldest = map.keys().next().value;
  if (oldest) map.delete(oldest);
}

// ── 导出缓存统计（供 runtime-metrics 更新） ────────────────
export function getCacheStats() {
  return {
    successEntries: successCache.size,
    failureEntries: failureCache.size,
    inFlight: inFlightOrigins.size,
  };
}

// ── SSRF 防护 ────────────────────────────────────────────
function serviceError(code, message) {
  return new ServiceError(code, message);
}

/** Return true for non-public IPv4/IPv6 addresses. */
export function isPrivateAddress(ip) {
  const value = ip.toLowerCase().replace(/^\[|\]$/g, "");

  if (value.startsWith("::ffff:")) {
    return isPrivateAddress(value.slice(7));
  }

  if (value.includes(":")) {
    return value === "::" || value === "::1" ||
      value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff") ||
      value.startsWith("fec") || value.startsWith("fed") || value.startsWith("fee") || value.startsWith("fef") ||
      value.startsWith("2001:db8:");
  }

  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

export async function assertPublicHost(hostname, lookupFn = lookup) {
  let addresses;
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch {
    throw serviceError("DNS_ERROR");
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw serviceError("PRIVATE_ADDRESS");
  }
}

/** Fetch with SSRF validation before the initial request and every redirect hop. */
export async function safeFetch(rawUrl, options = {}, dependencies = {}) {
  const lookupFn = dependencies.lookupFn || lookup;
  const fetchFn = dependencies.fetchFn || fetch;
  let currentUrl;

  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw serviceError("INVALID_URL");
  }

  if (!/^https?:$/.test(currentUrl.protocol)) {
    throw serviceError("INVALID_URL", "Only HTTP and HTTPS URLs are supported");
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicHost(currentUrl.hostname, lookupFn);

    const response = await fetchFn(currentUrl, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl.toString() };
    }

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl.toString() };
    await response.body?.cancel().catch(() => {});
    if (redirectCount === MAX_REDIRECTS) throw new Error("Too many redirects");

    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      throw serviceError("INVALID_URL", "Invalid redirect URL");
    }
  }

  throw new Error("Too many redirects");
}

// ── HTML 解析 ────────────────────────────────────────────
export function extractFaviconUrl(html, baseUrl) {
  const linkRegex = /<link\b[^>]*?\b(?:rel|href)\s*=\s*["'][^"']*["'][^>]*?\b(?:rel|href)\s*=\s*["'][^"']*["'][^>]*?>/gi;
  const candidates = [];

  for (const linkHtml of html.match(linkRegex) || []) {
    const rel = extractAttr(linkHtml, "rel")?.toLowerCase() || "";
    const href = extractAttr(linkHtml, "href");
    if (!href) continue;

    const sizes = extractAttr(linkHtml, "sizes");
    const size = sizes ? parseLargestSize(sizes) : 0;
    if (rel === "icon" || rel === "shortcut icon") {
      candidates.push({ href, priority: 10, size });
    } else if (rel === "apple-touch-icon" || rel === "apple-touch-icon-precomposed") {
      candidates.push({ href, priority: 5, size });
    } else if (rel.includes("icon")) {
      candidates.push({ href, priority: 3, size });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority || b.size - a.size);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.href, baseUrl);
      if (/^https?:$/.test(url.protocol)) return url.toString();
    } catch {
      // Try the next declared icon.
    }
  }
  return new URL("/favicon.ico", baseUrl).toString();
}

function extractAttr(html, attr) {
  const match = html.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? match[1] : null;
}

function parseLargestSize(sizes) {
  let max = 0;
  for (const part of sizes.split(/\s+/)) {
    const width = parseInt(part.split(/[x×]/)[0], 10);
    if (width > max) max = width;
  }
  return max;
}

// ── URL 规范化 ──────────────────────────────────────────
function normalizeUrl(raw) {
  const value = raw.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    throw new ServiceError("INVALID_URL");
  }
  const input = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ServiceError("INVALID_URL");
  }

  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new ServiceError("INVALID_URL");
  }
  return new URL(url.origin);
}

// ── 图片校验 ────────────────────────────────────────────
function detectContentType(url, headers) {
  const contentType = headers?.get("content-type") || "";
  if (contentType.startsWith("image/")) return contentType.split(";")[0].trim();

  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return {
    svg: "image/svg+xml",
    png: "image/png",
    ico: "image/x-icon",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  }[extension] || "image/x-icon";
}

export function isValidImageBuffer(buffer) {
  if (!buffer || buffer.length < 64) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return buffer.readUInt32BE(16) >= 2 && buffer.readUInt32BE(20) >= 2;
  }
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return true;
  const prefix = buffer.subarray(0, 300).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"));
}

async function readBodyWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength && contentLength > maxBytes) throw new Error("Upstream response is too large");

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Upstream response is too large");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}

// ── 实际抓取（带剩余时间预算） ────────────────────────────
async function fetchSingleFavicon(faviconUrl, remainingMs) {
  const deadline = Date.now() + Math.max(1000, remainingMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, remainingMs));

  try {
    const { response, finalUrl } = await safeFetch(faviconUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "favicon-api/1.0 (favicon fetcher; +https://github.com/VeteranBoLuo/favicon-api)",
      },
    });
    const nowRemaining = Math.max(0, deadline - Date.now());
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);

    const buffer = await readBodyWithLimit(response, MAX_FAVICON_SIZE);
    if (!isValidImageBuffer(buffer)) throw new Error("Fetched content is not a valid image");
    return { buffer, contentType: detectContentType(finalUrl, response.headers), finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

// ── 聚合源 ──────────────────────────────────────────────
const AGGREGATOR_BUILDERS = [
  { name: "favicone", build: (host) => `https://favicone.com/${host}?s=64` },
  { name: "yandex", build: (host) => `https://favicon.yandex.net/favicon/v2/https://${host}?size=32` },
];

async function fetchFromAggregator(hostname, sourceName, sourceUrl, remainingMs) {
  // 聚合源请求至少 4 秒超时，不受总预算剩余时间影响
  const minTimeout = Math.max(remainingMs, 4000);
  try {
    const { buffer, contentType, finalUrl } = await fetchSingleFavicon(sourceUrl, minTimeout);
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (AGGREGATOR_PLACEHOLDER_HASHES.has(hash)) return null;
    return { buffer, contentType, sourceUrl: finalUrl, sourceType: sourceName };
  } catch {
    return null;
  }
}

// ── 竞速抓取 ────────────────────────────────────────────
const SOURCE_TYPES = {
  DECLARED: "declared",
  FAVICON_ICO: "favicon",
  FAVICONE: "favicone",
  YANDEX: "yandex",
};

/**
 * 顺序抓取（旧版逻辑但使用新的总时间预算和错误处理）
 * 先 HTML → 声明图标 → 若失败查 /favicon.ico → 聚合源兜底
 */
async function fetchSequential(pageUrl, hostname, deadlineMs) {
  const overallDeadline = Date.now() + Math.max(2000, deadlineMs);
  function remaining() { return Math.max(500, overallDeadline - Date.now()); }

  let html = "";
  let pageRedirectedUrl = pageUrl;

  // 1. 抓取 HTML
  const acHtml = new AbortController();
  try {
    const fetched = await safeFetch(pageUrl, {
      signal: acHtml.signal,
      headers: { "User-Agent": "favicon-api/1.0", Accept: "text/html" },
    });
    pageRedirectedUrl = fetched.finalUrl;
    if (fetched.response.ok) {
      html = (await readBodyWithLimit(fetched.response, MAX_HTML_SIZE)).toString("utf8");
    }
  } catch (error) {
    if (error.code === "PRIVATE_ADDRESS" || error.code === "DNS_ERROR") throw error;
  }

  // 2. 尝试声明图标
  const faviconUrl = html ? extractFaviconUrl(html, pageRedirectedUrl) : new URL("/favicon.ico", pageRedirectedUrl).toString();
  try {
    const icon = await fetchSingleFavicon(faviconUrl, remaining());
    runtimeMetrics.increment("faviconIcoSuccess");
    return { ...icon, sourceType: "favicon" };
  } catch {
    // fall through to aggregators
  }

  // 3. 聚合源兜底
  for (const { name, build } of AGGREGATOR_BUILDERS) {
    const sourceUrl = build(hostname);
    try {
      const result = await fetchFromAggregator(hostname, name, sourceUrl, remaining());
      if (result) return result;
    } catch {
      // try next
    }
  }

  return null;
}

// ── getFavicon 入口（inFlight 合并 + 缓存 + 限流） ────────
export async function getFavicon(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const originKey = url.origin;
  const now = Date.now();

  runtimeMetrics.increment("totalRequests");

  // 1. 成功缓存
  const cached = successCache.get(originKey);
  if (cached && now - cached.at < SUCCESS_CACHE_TTL_MS) {
    runtimeMetrics.increment("cacheHitCount");
    return { ...cached.result, sourceType: "cache" };
  }

  // 2. 失败缓存（非 retryable 的长缓存错误也返回）
  const failCached = failureCache.get(originKey);
  if (failCached) {
    const ttl = getFailTtl(failCached.errorCode);
    if (ttl > 0 && now - failCached.at < ttl) {
      runtimeMetrics.increment("cacheHitCount");
      const err = new ServiceError(failCached.errorCode);
      throw err;
    }
    // 短缓存的 retryable 错误过期后也清除
    if (ttl === 0 || now - failCached.at >= ttl) {
      failureCache.delete(originKey);
    }
  }

  // 3. inFlight 合并
  const existingReq = inFlightOrigins.get(originKey);
  if (existingReq) {
    runtimeMetrics.increment("deduplicatedCount");
    const result = await existingReq;
    return { ...result, sourceType: "cache" };
  }

  runtimeMetrics.increment("cacheMissCount");

  // 4. 尝试持久缓存（磁盘）
  try {
    const persistent = await readPersistentCache(originKey);
    if (persistent) {
      // 填回内存缓存
      cachePrune(successCache, SUCCESS_CACHE_MAX);
      successCache.set(originKey, { at: Date.now(), result: persistent });
      runtimeMetrics.increment("cacheHitCount");
      return { ...persistent, sourceType: "cache" };
    }
  } catch {
    // 持久缓存读取失败不阻塞
  }

  // 5. 等待限流许可
  const release = await limiter.acquire();

  // 5. 创建真实抓取 Promise
  const fetchPromise = (async () => {
    try {
      const pageUrl = url.toString();

      const result = await fetchSequential(pageUrl, url.hostname, TOTAL_TIMEOUT_MS);

      if (!result || !result.buffer) {
        // 所有来源失败
        const err = new ServiceError("ICON_NOT_FOUND");
        const ttl = getFailTtl("ICON_NOT_FOUND");
        if (ttl > 0) {
          cachePrune(failureCache, SUCCESS_CACHE_MAX);
          failureCache.set(originKey, { at: Date.now(), errorCode: "ICON_NOT_FOUND", result: err });
        }
        runtimeMetrics.increment("notFoundCount");
        throw err;
      }

      // 成功——写入缓存
      cachePrune(successCache, SUCCESS_CACHE_MAX);
      successCache.set(originKey, { at: Date.now(), result });

      // 异步写入持久缓存（不阻塞）
      writePersistentCache(originKey, result);

      return result;
    } catch (err) {
      const se = err instanceof ServiceError ? err : classifyError(err);

      // 根据错误类型写入失败缓存
      const ttl = getFailTtl(se.code);
      if (ttl > 0) {
        cachePrune(failureCache, SUCCESS_CACHE_MAX);
        failureCache.set(originKey, { at: Date.now(), errorCode: se.code, result: se });
      }

      // 更新运行时指标
      if (se.code === "UPSTREAM_TIMEOUT") runtimeMetrics.increment("timeoutCount");
      else if (se.code === "DNS_ERROR") runtimeMetrics.increment("dnsErrorCount");
      else if (se.code === "ICON_NOT_FOUND") runtimeMetrics.increment("notFoundCount");
      else if (se.code === "UPSTREAM_ERROR") runtimeMetrics.increment("upstreamErrorCount");
      else if (se.code === "PRIVATE_ADDRESS") runtimeMetrics.increment("privateAddressCount");
      else if (se.code === "QUEUE_FULL") runtimeMetrics.increment("queueRejectedCount");
      else runtimeMetrics.increment("internalErrorCount");

      throw se;
    } finally {
      release();
      inFlightOrigins.delete(originKey);
    }
  })();

  inFlightOrigins.set(originKey, fetchPromise);
  return fetchPromise;
}

export function generateETag(buffer) {
  return `"${createHash("sha1").update(buffer).digest("hex")}"`;
}
