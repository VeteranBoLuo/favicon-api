import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

const cache = new Map();

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CACHE_MAX = 500; // 缓存条目上限,超出按插入顺序淘汰最旧,避免内存无限增长
const FETCH_TIMEOUT = 6_000; // 6s(抓 favicon 图 / 聚合源)
const HTML_FETCH_TIMEOUT = 4_000; // 4s(抓目标网页 HTML;抓不到就快速降级到 /favicon.ico 或聚合源,避免慢站长时间卡住)
const MAX_FAVICON_SIZE = 5 * 1024 * 1024; // 5 MB

// ── SSRF 防护 ─────────────────────────────────────
// 判断 IP 是否落在私有/保留段(含 IPv4/IPv6 + 云元数据 169.254.169.254)
function isPrivateAddr(ip) {
  const v = ip.replace(/^::ffff:/i, "");
  if (v.includes(":")) {
    const l = v.toLowerCase();
    return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") ||
      l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
  }
  const p = v.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 解析不了当作不安全
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// 解析主机名的所有 IP,任一落在私有段就拒绝(挡内网/回环/云元数据 SSRF)。
// 注:未固定解析结果到连接,极端的 DNS rebinding 仍有残留窗口,但常见攻击向量已覆盖。
async function assertPublicHost(hostname) {
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error("无法解析该域名");
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddr(a.address))) {
    throw new Error("拒绝访问内网/保留地址");
  }
}

/**
 * Extract favicon URL from a website's HTML.
 * Priority: <link rel="icon"> > <link rel="shortcut icon"> > apple-touch-icon > /favicon.ico
 */
function extractFaviconUrl(html, baseUrl) {
  const linkRegex = /<link\b[^>]*?\b(?:rel|href)\s*=\s*["'][^"']*["'][^>]*?\b(?:rel|href)\s*=\s*["'][^"']*["'][^>]*?>/gi;
  const links = html.match(linkRegex) || [];

  const candidates = [];

  for (const linkHtml of links) {
    const rel = extractAttr(linkHtml, "rel")?.toLowerCase() || "";
    const href = extractAttr(linkHtml, "href");
    if (!href) continue;

    const sizes = extractAttr(linkHtml, "sizes");
    const sizeVal = sizes ? parseLargestSize(sizes) : 0;

    if (rel === "icon" || rel === "shortcut icon") {
      candidates.push({ href, priority: 10, size: sizeVal });
    } else if (rel === "apple-touch-icon" || rel === "apple-touch-icon-precomposed") {
      candidates.push({ href, priority: 5, size: sizeVal });
    } else if (rel.includes("icon")) {
      candidates.push({ href, priority: 3, size: sizeVal });
    }
  }

  // Sort by priority then by size (larger = better for icon)
  candidates.sort((a, b) => b.priority - a.priority || b.size - a.size);

  if (candidates.length > 0) {
    return resolveUrl(candidates[0].href, baseUrl);
  }

  // Fallback: default /favicon.ico
  return `${baseUrl.origin}/favicon.ico`;
}

function extractAttr(html, attr) {
  const match = html.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? match[1] : null;
}

function parseLargestSize(sizes) {
  const parts = sizes.split(/\s+/);
  let max = 0;
  for (const part of parts) {
    const w = parseInt(part.split(/[x×]/)[0], 10);
    if (w > max) max = w;
  }
  return max;
}

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return `${baseUrl.origin}${href.startsWith("/") ? "" : "/"}${href}`;
  }
}

/**
 * Normalize user input to a proper URL.
 * Accepts any format: full URL with query params, just domain, with/without protocol.
 * Always strips to origin for favicon search.
 */
function normalizeUrl(raw) {
  let input = raw.trim();

  // Remove protocol if present for cleaner parsing
  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  // Extract domain — handle malformed URLs gracefully
  let origin;
  try {
    const url = new URL(input);
    origin = url.origin;
  } catch {
    // If URL parsing fails, try to extract domain via regex
    const match = input.match(/^(?:https?:\/\/)?([^\/\s?#]+)/);
    if (!match) throw new Error("Invalid domain");
    origin = `https://${match[1]}`;
  }

  return { url: new URL(origin), originalUrl: origin };
}

/**
 * Detect content type from favicon URL extension or response headers.
 */
function detectContentType(url, responseHeaders) {
  const contentType = responseHeaders?.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    return contentType.split(";")[0].trim();
  }

  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
  const types = {
    svg: "image/svg+xml",
    png: "image/png",
    ico: "image/x-icon",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return types[ext] || "image/x-icon";
}

// 校验 buffer 是有效图片(按文件头 magic bytes),排除 HTML 页面、空图、1x1 透明占位。
// 常见坑:站点 favicon 放 1x1 透明 png;SPA 的 /favicon.ico 命中前端路由返回 HTML —— 都判无效,好交给聚合源兜底。
function isValidImageBuffer(buffer) {
  if (!buffer || buffer.length < 64) return false; // 过小(1x1 png=70B / 空)
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    // PNG:读 IHDR 宽高,拒 1x1 占位
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    return w >= 2 && h >= 2;
  }
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return true; // ICO
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return true; // WebP(RIFF....WEBP)
  if (b.slice(0, 300).toString("utf8").toLowerCase().includes("<svg")) return true; // SVG
  return false; // HTML / 其它 → 无效
}

/**
 * Fetch favicon from a given URL with timeout.
 */
async function fetchFavicon(faviconUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(faviconUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "favicon-api/1.0 (favicon fetcher; +https://github.com/VeteranBoLuo/favicon-api)",
      },
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FAVICON_SIZE) {
      throw new Error("Favicon too large");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_FAVICON_SIZE) {
      throw new Error("Favicon too large");
    }

    const buffer = Buffer.from(arrayBuffer);
    // 校验真的是图片:排除 1x1 透明占位、SPA 的 /favicon.ico 返回 HTML 等"假图标",抛错交由上层兜底聚合源
    if (!isValidImageBuffer(buffer)) {
      throw new Error("Fetched content is not a valid image");
    }

    const contentType = detectContentType(faviconUrl, response.headers);

    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

// 图标聚合兜底源:目标站直连失败(强反爬 403 / 无 favicon.ico / 超时)时,从公网聚合服务取。
// 这些服务自带爬虫与缓存,能拿到 Cloudflare 类反爬站(如 pexels)的真实图标;按序取第一个成功的。
const AGGREGATOR_BUILDERS = [
  (host) => `https://favicone.com/${host}?s=64`,
  (host) => `https://favicon.yandex.net/favicon/v2/https://${host}?size=32`,
];
// 聚合源对"没有真 logo 的站"会返回固定占位图(HTTP 200,而非 404),按 sha256 识别并跳过,避免把占位当真图。
// favicone:文档样式占位;yandex:1x1 空图(已被 isValidImageBuffer 的 1x1 校验拦掉,无需列此)。
const AGGREGATOR_PLACEHOLDER_HASHES = new Set([
  "ebfb7deb2782f551f757a9077203194dedeb132c091005204135905134e4b0e7", // favicone 无 logo 时的文档占位
]);
async function fetchFromAggregator(hostname) {
  for (const build of AGGREGATOR_BUILDERS) {
    const src = build(hostname);
    try {
      await assertPublicHost(new URL(src).hostname); // 兜底源同样过 SSRF 校验
      const { buffer, contentType } = await fetchFavicon(src);
      if (!buffer || !buffer.length) continue;
      if (AGGREGATOR_PLACEHOLDER_HASHES.has(createHash("sha256").update(buffer).digest("hex"))) continue; // 占位图,试下一个源
      return { buffer, contentType, sourceUrl: src };
    } catch {
      // 当前兜底源失败,试下一个
    }
  }
  return null;
}

/**
 * Main entry: given a domain, find and return its favicon.
 * Returns { buffer, contentType, sourceUrl }
 */
export async function getFavicon(rawUrl) {
  const { url } = normalizeUrl(rawUrl);
  const cacheKey = url.origin;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.result;
  }

  // 拦截内网/保留地址,再发起任何服务端请求
  await assertPublicHost(url.hostname);

  // Step 1: Fetch the HTML of the target site
  const htmlController = new AbortController();
  const htmlTimer = setTimeout(() => htmlController.abort(), HTML_FETCH_TIMEOUT);

  let html = "";
  try {
    const htmlResponse = await fetch(url.toString(), {
      signal: htmlController.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "favicon-api/1.0",
        Accept: "text/html",
      },
    });
    html = await htmlResponse.text();
  } catch {
    // If we can't fetch HTML, try the default favicon.ico directly
  } finally {
    clearTimeout(htmlTimer);
  }

  // Step 2: Extract favicon URL
  const faviconUrl = html
    ? extractFaviconUrl(html, url)
    : `${url.origin}/favicon.ico`;

  // Step 3: Fetch the favicon(图标可能在别的主机上,同样校验);直连失败则兜底聚合源
  let result;
  try {
    await assertPublicHost(new URL(faviconUrl).hostname);
    const { buffer, contentType } = await fetchFavicon(faviconUrl);
    result = { buffer, contentType, sourceUrl: faviconUrl };
  } catch (err) {
    // 目标站强反爬(403)/无 favicon.ico/超时 → 兜底到公网图标聚合服务
    result = await fetchFromAggregator(url.hostname);
    if (!result) throw err; // 兜底也拿不到,抛出原始错误(交由上层转 403/404/502)
  }
  // 超出上限先淘汰最旧的一条(Map 按插入顺序)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), result });

  return result;
}

/**
 * 基于图标内容生成 ETag,内容不变则 ETag 不变,浏览器 304 协商缓存才能真正命中。
 * (原实现用 randomUUID,每次都变,304 永远失效)
 */
export function generateETag(buffer) {
  return `"${createHash("sha1").update(buffer).digest("hex")}"`;
}
