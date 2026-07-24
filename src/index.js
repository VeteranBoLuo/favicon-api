import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { getFavicon, generateETag } from "./favicon.js";
import { ServiceError, classifyError } from "./error.js";
import { limiter } from "./limiter.js";
import { runtimeMetrics } from "./runtime-metrics.js";
import { getCacheStats } from "./favicon.js";
import { usageCounter } from "./usage-counter.js";
import { usageQualifier } from "./usage-qualifier.js";

const PORT = parseInt(process.env.PORT || "3456", 10);
const DEMO_HTML = readFileSync(new URL("../public/index.html", import.meta.url));
const PUBLIC_ASSETS = new Map([
  ["favicon.svg", { contentType: "image/svg+xml; charset=utf-8", body: readFileSync(new URL("../public/favicon.svg", import.meta.url)) }],
  ["favicon.ico", { contentType: "image/x-icon", body: readFileSync(new URL("../public/favicon.ico", import.meta.url)) }],
  ["favicon-16x16.png", { contentType: "image/png", body: readFileSync(new URL("../public/favicon-16x16.png", import.meta.url)) }],
  ["favicon-32x32.png", { contentType: "image/png", body: readFileSync(new URL("../public/favicon-32x32.png", import.meta.url)) }],
  ["apple-touch-icon.png", { contentType: "image/png", body: readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url)) }],
  ["site.webmanifest", { contentType: "application/manifest+json; charset=utf-8", body: readFileSync(new URL("../public/site.webmanifest", import.meta.url)) }],
]);

const HEDGED_FETCH_ENABLED = process.env.FAVICON_HEDGED_FETCH_ENABLED !== "false";
const QUEUE_ENABLED = process.env.FAVICON_QUEUE_ENABLED !== "false";
const FAILURE_CACHE_ENABLED = process.env.FAVICON_FAILURE_CACHE_ENABLED !== "false";

export async function handle(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "If-None-Match");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const parsedUrl = new URL(req.url, "http://localhost");

  const assetName = parsedUrl.pathname.split("/").pop();
  const asset = PUBLIC_ASSETS.get(assetName);
  if (asset) {
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": asset.body.length,
      "Cache-Control": "public, max-age=86400",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(asset.body);
    return;
  }

  // /health
  if (parsedUrl.pathname === "/health" || parsedUrl.pathname.endsWith("/health")) {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // /runtime
  if (parsedUrl.pathname === "/runtime" || parsedUrl.pathname.endsWith("/runtime")) {
    const cs = getCacheStats();
    const s = runtimeMetrics.snapshot();
    sendJson(res, 200, {
      status: "ok",
      active: limiter.active,
      queued: limiter.queued,
      concurrency: limiter.concurrency,
      inFlightOrigins: cs.inFlight,
      successCacheEntries: cs.successEntries,
      failureCacheEntries: cs.failureEntries,
      hedgedFetchEnabled: HEDGED_FETCH_ENABLED,
      queueEnabled: QUEUE_ENABLED,
      failureCacheEnabled: FAILURE_CACHE_ENABLED,
      totalRequests: s.totalRequests,
      successCount: s.successCount,
      timeoutCount: s.timeoutCount,
      queueRejectedCount: s.queueRejectedCount,
      deduplicatedCount: s.deduplicatedCount,
      cacheHitCount: s.cacheHitCount,
      cacheMissCount: s.cacheMissCount,
      averageDuration: s.averageDuration,
      p50Duration: s.p50Duration,
      p95Duration: s.p95Duration,
    }, { "Cache-Control": "no-store" });
    return;
  }

  // /stats
  if (parsedUrl.pathname === "/stats" || parsedUrl.pathname.endsWith("/stats")) {
    sendJson(res, 200, { count: await usageCounter.value() }, {
      "Cache-Control": "no-store",
    });
    return;
  }

  const domain = (parsedUrl.searchParams.get("url") || "").trim();
  if (domain) {
    const countUsage = parsedUrl.searchParams.get("preview") !== "1";
    await serveFavicon(req, res, domain, countUsage);
    return;
  }

  // Demo page
  if (!parsedUrl.search) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": DEMO_HTML.length,
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
    });
    res.end(DEMO_HTML);
    return;
  }

  sendJson(res, 400, { error: "Missing url parameter. Usage: ?url=example.com" });
}

async function serveFavicon(req, res, domain, countUsage) {
  if (domain.length > 512 || domain.includes("\n") || domain.includes("\r")) {
    sendJson(res, 400, { code: "INVALID_URL", retryable: false, error: "Invalid URL" });
    return;
  }

  const start = performance.now();

  try {
    const result = await getFavicon(domain);
    const etag = generateETag(result.buffer);
    const durationMs = Math.round(performance.now() - start);

    if (countUsage && usageQualifier.shouldCountRequest(req, domain)) {
      await usageCounter.increment();
    }

    runtimeMetrics.recordDuration(durationMs);

    const headers = {
      "Cache-Control": "public, max-age=3600",
      "ETag": etag,
      "X-Favicon-Cache": result.sourceType === "cache" ? "hit" : "miss",
      "X-Favicon-Duration-Ms": String(durationMs),
      "X-Favicon-Source-Type": result.sourceType || "unknown",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Content-Type": result.contentType,
      "Content-Length": result.buffer.length,
    };

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    res.end(result.buffer);
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const se = error instanceof ServiceError ? error : classifyError(error);

    // 非 INVALID_URL 的错误记录持续时间
    if (se.code !== "INVALID_URL") {
      runtimeMetrics.recordDuration(durationMs);
    }

    const body = se.toJSON();
    const headers = {
      "X-Favicon-Cache": "miss",
      "X-Favicon-Duration-Ms": String(durationMs),
      "Content-Type": "application/json; charset=utf-8",
    };
    if (se.retryable) {
      headers["Retry-After"] = String(limiter.retryAfter);
    }
    sendJson(res, se.httpStatus, body, headers);
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

const server = createServer(handle);

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`favicon-api running at http://localhost:${PORT}`);
  });
}
