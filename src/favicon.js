/**
 * favicon 抓取核心逻辑
 *
 * - 同 Origin 进行中请求合并（inFlight Map，在 limiter 等待前登记）
 * - 真实 Hedged Fetch（/favicon.ico 与 HTML 声明图标并行，聚合源延迟启动）
 * - 成功缓存 + 失败短缓存
 * - 总时间预算
 * - SSRF 防护（保持不变）
 * - 与 limiter 和 runtime-metrics 集成
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { ServiceError, classifyError } from "./error.js";
import { limiter } from "./limiter.js";
import { runtimeMetrics } from "./runtime-metrics.js";
import { readPersistentCache, writePersistentCache } from "./persistent-cache.js";

// ── 环境变量 ──────────────────────────────────────────────
const TOTAL_TIMEOUT_MS = parseInt(process.env.FAVICON_TOTAL_TIMEOUT_MS || "8000", 10);
const HTML_TIMEOUT_MS = parseInt(process.env.FAVICON_HTML_TIMEOUT_MS || "2200", 10);
const ICON_TIMEOUT_MS = parseInt(process.env.FAVICON_ICON_TIMEOUT_MS || "3200", 10);
const AGGREGATOR_TIMEOUT_MS = parseInt(process.env.FAVICON_AGGREGATOR_TIMEOUT_MS || "3500", 10);
const FIRST_HEDGE_MS = parseInt(process.env.FAVICON_AGGREGATOR_HEDGE_MS || "700", 10);
const SECOND_HEDGE_MS = parseInt(process.env.FAVICON_SECOND_AGGREGATOR_HEDGE_MS || "1200", 10);
const SUCCESS_CACHE_TTL_MS = parseInt(process.env.FAVICON_SUCCESS_CACHE_TTL_MS || "3600000", 10);
const SUCCESS_CACHE_MAX = parseInt(process.env.FAVICON_SUCCESS_CACHE_MAX || "1500", 10);

const MAX_FAVICON_SIZE = 5 * 1024 * 1024;
const MAX_HTML_SIZE = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const AGGREGATOR_PLACEHOLDER_HASHES = new Set([
  "ebfb7deb2782f551f757a9077203194dedeb132c091005204135905134e4b0e7",
]);

// ── 功能开关 ──────────────────────────────────────────────
const HEDGED_FETCH_ENABLED = process.env.FAVICON_HEDGED_FETCH_ENABLED !== 'false';
const FAILURE_CACHE_ENABLED = process.env.FAVICON_FAILURE_CACHE_ENABLED !== 'false';

// ── 缓存 ──────────────────────────────────────────────────
const successCache = new Map();
const failureCache = new Map();
const inFlightOrigins = new Map();

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
  return FAIL_TTL[code] !== undefined ? FAIL_TTL[code] : 60_000;
}

function cachePrune(map, maxSize) {
  if (map.size < maxSize) return;
  const oldest = map.keys().next().value;
  if (oldest) map.delete(oldest);
}

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

export function isPrivateAddress(ip) {
  const value = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  if (value.includes(":")) {
    return value === "::" || value === "::1" ||
      value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff") ||
      value.startsWith("fec") || value.startsWith("fed") || value.startsWith("fee") || value.startsWith("fef") ||
      value.startsWith("2001:db8:");
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
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
  try { addresses = await lookupFn(hostname, { all: true }); }
  catch { throw serviceError("DNS_ERROR"); }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw serviceError("PRIVATE_ADDRESS");
  }
}

export async function safeFetch(rawUrl, options = {}, dependencies = {}) {
  const lookupFn = dependencies.lookupFn || lookup;
  const fetchFn = dependencies.fetchFn || fetch;
  let currentUrl;
  try { currentUrl = new URL(rawUrl); }
  catch { throw serviceError("INVALID_URL"); }
  if (!/^https?:$/.test(currentUrl.protocol)) throw serviceError("INVALID_URL");
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!/^https?:$/.test(currentUrl.protocol)) throw serviceError("INVALID_URL");
    if (options.signal?.aborted) throw options.signal.reason;
    const wait = (promise) => options.signal ? waitForPromiseWithSignal(promise, options.signal) : promise;
    await wait(assertPublicHost(currentUrl.hostname, lookupFn));
    if (options.signal?.aborted) throw options.signal.reason;
    const response = await wait(fetchFn(currentUrl, { ...options, redirect: "manual" }));
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: currentUrl.toString() };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl.toString() };
    await response.body?.cancel().catch(() => {});
    if (redirectCount === MAX_REDIRECTS) throw new Error("Too many redirects");
    try { currentUrl = new URL(location, currentUrl); }
    catch { throw serviceError("INVALID_URL", "Invalid redirect URL"); }
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
    if (rel === "icon" || rel === "shortcut icon") candidates.push({ href, priority: 10, size });
    else if (rel === "apple-touch-icon" || rel === "apple-touch-icon-precomposed") candidates.push({ href, priority: 5, size });
    else if (rel.includes("icon")) candidates.push({ href, priority: 3, size });
  }
  candidates.sort((a, b) => b.priority - a.priority || b.size - a.size);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.href, baseUrl);
      if (/^https?:$/.test(url.protocol)) return url.toString();
    } catch { /* try next */ }
  }
  return new URL("/favicon.ico", baseUrl).toString();
}

function extractAttr(html, attr) {
  return html.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || null;
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
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) throw new ServiceError("INVALID_URL");
  const input = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try { url = new URL(input); }
  catch { throw new ServiceError("INVALID_URL"); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new ServiceError("INVALID_URL");
  return new URL(url.origin);
}

// ── 图片校验 ────────────────────────────────────────────
function detectContentType(url, headers) {
  const ct = headers?.get("content-type") || "";
  if (ct.startsWith("image/")) return ct.split(";")[0].trim();
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] || "image/x-icon";
}

export function isValidImageBuffer(buffer) {
  if (!buffer || buffer.length < 64) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return buffer.readUInt32BE(16) >= 2 && buffer.readUInt32BE(20) >= 2;
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return true;
  const prefix = buffer.subarray(0, 300).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"));
}

async function readBodyWithLimit(response, maxBytes, signal) {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ServiceError("UPSTREAM_ERROR");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ServiceError("UPSTREAM_ERROR");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

// ── 带超时和信号管理的抓取 ──────────────────────────────
function assertAbortSignal(signal) {
  if (
    !signal ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function" ||
    typeof signal.aborted !== "boolean"
  ) {
    const error = new TypeError("Expected AbortSignal");
    error.code = "INVALID_ABORT_SIGNAL";
    throw error;
  }
}

function remainingMs(deadline, capMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ServiceError("UPSTREAM_TIMEOUT");
  return Math.min(capMs, remaining);
}

function waitForPromiseWithSignal(promise, signal) {
  assertAbortSignal(signal);
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason || new ServiceError("UPSTREAM_TIMEOUT"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new ServiceError("UPSTREAM_TIMEOUT"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function fetchWithTimeout(url, { parentSignal, timeoutMs, headers, maxBytes }, dependencies = {}) {
  assertAbortSignal(parentSignal);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason || new Error("Aborted"));
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new ServiceError("UPSTREAM_TIMEOUT")), timeoutMs);
  try {
    const fetched = await safeFetch(url, { signal: controller.signal, headers }, dependencies);
    if (!fetched.response.ok) {
      await fetched.response.body?.cancel().catch(() => {});
      throw new ServiceError([404, 410].includes(fetched.response.status) ? "ICON_NOT_FOUND" : "UPSTREAM_ERROR");
    }
    const buffer = await waitForPromiseWithSignal(
      readBodyWithLimit(fetched.response, maxBytes, controller.signal), controller.signal,
    );
    return { ...fetched, buffer };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

// ── 聚合源 ──────────────────────────────────────────────
const AGGREGATOR_BUILDERS = [
  { name: "favicone", build: (host) => `https://favicone.com/${host}?s=64` },
  { name: "yandex", build: (host) => `https://favicon.yandex.net/favicon/v2/https://${host}?size=32` },
];

async function fetchSingleFavicon(faviconUrl, timeoutMs, parentSignal) {
  const { response, finalUrl, buffer } = await fetchWithTimeout(faviconUrl, {
    parentSignal, timeoutMs, maxBytes: MAX_FAVICON_SIZE,
    headers: { "User-Agent": "favicon-api/1.0 (favicon fetcher; +https://github.com/VeteranBoLuo/favicon-api)" },
  });
  if (!isValidImageBuffer(buffer)) throw new ServiceError("ICON_NOT_FOUND");
  return { buffer, contentType: detectContentType(finalUrl, response.headers), finalUrl };
}

function delayedAttempt(delayMs, signal, factory) {
  assertAbortSignal(signal);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => settle(
      reject,
      signal.reason || new ServiceError("UPSTREAM_TIMEOUT"),
    );
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(factory)
        .then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error),
        );
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchRootFavicon({ originUrl, deadline, signal }) {
  const faviconUrl = new URL("/favicon.ico", originUrl).toString();
  const result = await fetchSingleFavicon(
    faviconUrl,
    remainingMs(deadline, ICON_TIMEOUT_MS),
    signal,
  );
  return { ...result, sourceType: "favicon" };
}

async function fetchDeclaredFavicon({
  originUrl,
  attemptedRootUrl,
  deadline,
  signal,
}) {
  const fetched = await fetchWithTimeout(originUrl, {
    parentSignal: signal,
    timeoutMs: remainingMs(deadline, HTML_TIMEOUT_MS),
    maxBytes: MAX_HTML_SIZE,
    headers: { "User-Agent": "favicon-api/1.0", Accept: "text/html" },
  });

  const html = fetched.buffer.toString("utf8");
  const declaredUrl = extractFaviconUrl(html, fetched.finalUrl);
  if (declaredUrl === attemptedRootUrl) {
    throw new ServiceError("ICON_NOT_FOUND");
  }

  const result = await fetchSingleFavicon(
    declaredUrl,
    remainingMs(deadline, ICON_TIMEOUT_MS),
    signal,
  );
  const redirectedRootUrl = new URL("/favicon.ico", fetched.finalUrl).toString();
  return {
    ...result,
    sourceType: declaredUrl === redirectedRootUrl ? "favicon" : "declared",
  };
}

async function fetchFromAggregator({
  name,
  hostname,
  sourceUrl,
  deadline,
  signal,
}) {
  const result = await fetchSingleFavicon(
    sourceUrl,
    remainingMs(deadline, AGGREGATOR_TIMEOUT_MS),
    signal,
  );
  const hash = createHash("sha256").update(result.buffer).digest("hex");
  if (AGGREGATOR_PLACEHOLDER_HASHES.has(hash)) {
    throw new ServiceError("ICON_NOT_FOUND");
  }
  return { ...result, sourceType: name };
}

const AGGREGATE_ERROR_PRIORITY = [
  "PRIVATE_ADDRESS",
  "INVALID_URL",
  "DNS_ERROR",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
  "ICON_NOT_FOUND",
];

function pickAggregateError(error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  const classified = errors.map((item) => (
    item instanceof ServiceError ? item : classifyError(item)
  ));

  for (const code of AGGREGATE_ERROR_PRIORITY) {
    const match = classified.find((item) => item.code === code);
    if (match) return match;
  }
  return new ServiceError("INTERNAL_ERROR");
}

// ── Hedged Fetch ───────────────────────────────────────────
export async function fetchHedged(pageUrl, hostname, options = {}) {
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;
  const controller = new AbortController();
  const signal = controller.signal;
  const totalTimer = setTimeout(
    () => controller.abort(new ServiceError("UPSTREAM_TIMEOUT")),
    totalTimeoutMs,
  );
  const validateOrigin = options.validateOrigin || assertPublicHost;
  const fetchRoot = options.fetchRoot || fetchRootFavicon;
  const fetchDeclared = options.fetchDeclared || fetchDeclaredFavicon;
  const fetchAggregator = options.fetchAggregator || fetchFromAggregator;
  const rootFaviconUrl = new URL("/favicon.ico", pageUrl).toString();

  try {
    await waitForPromiseWithSignal(validateOrigin(hostname), signal);

    const sourceContext = {
      originUrl: pageUrl,
      hostname,
      attemptedRootUrl: rootFaviconUrl,
      deadline,
      signal,
    };
    const attempts = [
      fetchRoot(sourceContext),
      fetchDeclared(sourceContext),
      delayedAttempt(
        options.firstHedgeMs ?? FIRST_HEDGE_MS,
        signal,
        () => fetchAggregator({
          ...sourceContext,
          name: AGGREGATOR_BUILDERS[0].name,
          sourceUrl: AGGREGATOR_BUILDERS[0].build(hostname),
        }),
      ),
      delayedAttempt(
        options.secondHedgeMs ?? SECOND_HEDGE_MS,
        signal,
        () => fetchAggregator({
          ...sourceContext,
          name: AGGREGATOR_BUILDERS[1].name,
          sourceUrl: AGGREGATOR_BUILDERS[1].build(hostname),
        }),
      ),
    ];

    let result;
    try {
      result = await waitForPromiseWithSignal(Promise.any(attempts), signal);
    } catch (error) {
      throw pickAggregateError(error);
    }
    controller.abort(new Error("Favicon source selected"));
    return result;
  } finally {
    clearTimeout(totalTimer);
    if (!signal.aborted) controller.abort(new Error("Favicon request finished"));
  }
}

// ── 顺序兜底（功能开关关闭时使用） ────────────────────────
async function fetchSequentialFallback(pageUrl, hostname, { totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + totalTimeoutMs;
  const controller = new AbortController();
  const signal = controller.signal;
  const totalTimer = setTimeout(
    () => controller.abort(new ServiceError("UPSTREAM_TIMEOUT")),
    totalTimeoutMs,
  );
  const attemptedRootUrl = new URL("/favicon.ico", pageUrl).toString();
  const errors = [];

  try {
    await waitForPromiseWithSignal(assertPublicHost(hostname), signal);
    const sourceContext = {
      originUrl: pageUrl,
      hostname,
      attemptedRootUrl,
      deadline,
      signal,
    };

    for (const attempt of [
      () => fetchRootFavicon(sourceContext),
      () => fetchDeclaredFavicon(sourceContext),
    ]) {
      try {
        return await attempt();
      } catch (error) {
        const classified = error instanceof ServiceError ? error : classifyError(error);
        if (classified.code === "PRIVATE_ADDRESS" || classified.code === "INVALID_URL") {
          throw classified;
        }
        errors.push(classified);
      }
    }

    for (const { name, build } of AGGREGATOR_BUILDERS) {
      try {
        return await fetchFromAggregator({
          ...sourceContext,
          name,
          sourceUrl: build(hostname),
        });
      } catch (error) {
        errors.push(error instanceof ServiceError ? error : classifyError(error));
      }
    }

    throw pickAggregateError(new AggregateError(errors));
  } finally {
    clearTimeout(totalTimer);
    if (!signal.aborted) controller.abort(new Error("Favicon request finished"));
  }
}

// ── getFavicon 入口 ────────────────────────────────────────
export async function getFavicon(rawUrl, dependencies = {}) {
  const url = normalizeUrl(rawUrl);
  const originKey = url.origin;
  const now = Date.now();
  const requestLimiter = dependencies.limiter || limiter;

  runtimeMetrics.increment("totalRequests");

  // 1. 成功缓存
  const cached = successCache.get(originKey);
  if (cached && now - cached.at < SUCCESS_CACHE_TTL_MS) {
    runtimeMetrics.increment("cacheHitCount");
    return { ...cached.result, sourceType: "cache" };
  }

  // 2. 失败缓存
  if (FAILURE_CACHE_ENABLED) {
    const failCached = failureCache.get(originKey);
    if (failCached) {
      const ttl = getFailTtl(failCached.errorCode);
      if (ttl > 0 && now - failCached.at < ttl) {
        runtimeMetrics.increment("cacheHitCount");
        throw new ServiceError(failCached.errorCode);
      }
      if (ttl === 0 || now - failCached.at >= ttl) failureCache.delete(originKey);
    }
  }

  // 3. 持久缓存
  try {
    const persistent = await readPersistentCache(originKey);
    if (persistent) {
      cachePrune(successCache, SUCCESS_CACHE_MAX);
      successCache.set(originKey, { at: Date.now(), result: persistent });
      runtimeMetrics.increment("cacheHitCount");
      return { ...persistent, sourceType: "cache" };
    }
  } catch { /* ignore */ }

  runtimeMetrics.increment("cacheMissCount");

  // 4. inFlight 合并（在等待 limiter 前登记）
  const existing = inFlightOrigins.get(originKey);
  if (existing) {
    runtimeMetrics.increment("deduplicatedCount");
    return existing;
  }

  const fetchPromise = (async () => {
    let release = null;
    const totalTimeoutMs = dependencies.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
    const deadline = Date.now() + totalTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ServiceError(release ? 'UPSTREAM_TIMEOUT' : 'QUEUE_FULL')), totalTimeoutMs);
    try {
      release = await requestLimiter.acquire({ signal: controller.signal });
      runtimeMetrics.increment("externalFetchCount");
      const options = { totalTimeoutMs: remainingMs(deadline, totalTimeoutMs) };
      const result = HEDGED_FETCH_ENABLED
        ? await (dependencies.fetchHedged || fetchHedged)(url.toString(), url.hostname, options)
        : await fetchSequentialFallback(url.toString(), url.hostname, options);

      if (!result || !result.buffer) {
        const err = new ServiceError("ICON_NOT_FOUND");
        if (FAILURE_CACHE_ENABLED) {
          const ttl = getFailTtl("ICON_NOT_FOUND");
          if (ttl > 0) { cachePrune(failureCache, SUCCESS_CACHE_MAX); failureCache.set(originKey, { at: Date.now(), errorCode: "ICON_NOT_FOUND", result: err }); }
        }
        runtimeMetrics.increment("notFoundCount");
        throw err;
      }

      cachePrune(successCache, SUCCESS_CACHE_MAX);
      successCache.set(originKey, { at: Date.now(), result });
      writePersistentCache(originKey, result);
      return result;
    } catch (err) {
      const se = err instanceof ServiceError ? err : classifyError(err);
      if (FAILURE_CACHE_ENABLED) {
        const ttl = getFailTtl(se.code);
        if (ttl > 0) { cachePrune(failureCache, SUCCESS_CACHE_MAX); failureCache.set(originKey, { at: Date.now(), errorCode: se.code, result: se }); }
      }
      if (se.code === "UPSTREAM_TIMEOUT") runtimeMetrics.increment("timeoutCount");
      else if (se.code === "DNS_ERROR") runtimeMetrics.increment("dnsErrorCount");
      else if (se.code === "ICON_NOT_FOUND") runtimeMetrics.increment("notFoundCount");
      else if (se.code === "UPSTREAM_ERROR") runtimeMetrics.increment("upstreamErrorCount");
      else if (se.code === "PRIVATE_ADDRESS") runtimeMetrics.increment("privateAddressCount");
      else if (se.code === "QUEUE_FULL") runtimeMetrics.increment("queueRejectedCount");
      else runtimeMetrics.increment("internalErrorCount");
      throw se;
    } finally {
      clearTimeout(timer);
      release?.();
      inFlightOrigins.delete(originKey);
    }
  })();

  inFlightOrigins.set(originKey, fetchPromise);
  return fetchPromise;
}

export function generateETag(buffer) {
  return `"${createHash("sha1").update(buffer).digest("hex")}"`;
}
