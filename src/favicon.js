import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

const cache = new Map();

const CACHE_TTL = 60 * 60 * 1000;
const CACHE_MAX = 500;
const FETCH_TIMEOUT = 6_000;
const HTML_FETCH_TIMEOUT = 4_000;
const MAX_FAVICON_SIZE = 5 * 1024 * 1024;
const MAX_HTML_SIZE = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
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
    throw serviceError("DNS_ERROR", "Unable to resolve hostname");
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw serviceError("PRIVATE_ADDRESS", "Private and reserved addresses are not allowed");
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
    throw serviceError("INVALID_URL", "Invalid URL");
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

function normalizeUrl(raw) {
  const value = raw.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    throw serviceError("INVALID_URL", "Only HTTP and HTTPS URLs are supported");
  }
  const input = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw serviceError("INVALID_URL", "Invalid URL");
  }

  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    throw serviceError("INVALID_URL", "Only HTTP and HTTPS URLs are supported");
  }
  return new URL(url.origin);
}

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

async function fetchFavicon(faviconUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const { response, finalUrl } = await safeFetch(faviconUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "favicon-api/1.0 (favicon fetcher; +https://github.com/VeteranBoLuo/favicon-api)",
      },
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);

    const buffer = await readBodyWithLimit(response, MAX_FAVICON_SIZE);
    if (!isValidImageBuffer(buffer)) throw new Error("Fetched content is not a valid image");
    return { buffer, contentType: detectContentType(finalUrl, response.headers), finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

const AGGREGATOR_BUILDERS = [
  (host) => `https://favicone.com/${host}?s=64`,
  (host) => `https://favicon.yandex.net/favicon/v2/https://${host}?size=32`,
];

const AGGREGATOR_PLACEHOLDER_HASHES = new Set([
  "ebfb7deb2782f551f757a9077203194dedeb132c091005204135905134e4b0e7",
]);

async function fetchFromAggregator(hostname) {
  for (const buildUrl of AGGREGATOR_BUILDERS) {
    const sourceUrl = buildUrl(hostname);
    try {
      const { buffer, contentType, finalUrl } = await fetchFavicon(sourceUrl);
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (AGGREGATOR_PLACEHOLDER_HASHES.has(hash)) continue;
      return { buffer, contentType, sourceUrl: finalUrl };
    } catch {
      // Try the next source.
    }
  }
  return null;
}

export async function getFavicon(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const cacheKey = url.origin;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.result;

  let html = "";
  let pageUrl = url.toString();
  const htmlController = new AbortController();
  const htmlTimer = setTimeout(() => htmlController.abort(), HTML_FETCH_TIMEOUT);
  try {
    const fetched = await safeFetch(pageUrl, {
      signal: htmlController.signal,
      headers: { "User-Agent": "favicon-api/1.0", Accept: "text/html" },
    });
    pageUrl = fetched.finalUrl;
    if (fetched.response.ok) {
      html = (await readBodyWithLimit(fetched.response, MAX_HTML_SIZE)).toString("utf8");
    }
  } catch (error) {
    if (error.code === "PRIVATE_ADDRESS" || error.code === "DNS_ERROR") throw error;
  } finally {
    clearTimeout(htmlTimer);
  }

  const faviconUrl = html ? extractFaviconUrl(html, pageUrl) : new URL("/favicon.ico", pageUrl).toString();
  let result;
  try {
    const fetched = await fetchFavicon(faviconUrl);
    result = { buffer: fetched.buffer, contentType: fetched.contentType, sourceUrl: fetched.finalUrl };
  } catch (error) {
    result = await fetchFromAggregator(url.hostname);
    if (!result) throw error;
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}

export function generateETag(buffer) {
  return `"${createHash("sha1").update(buffer).digest("hex")}"`;
}
