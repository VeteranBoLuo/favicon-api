import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { getFavicon, generateETag } from "./favicon.js";

const PORT = parseInt(process.env.PORT || "3456", 10);
const DEMO_HTML = readFileSync(new URL("../public/index.html", import.meta.url));

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

  // Accept /health as well as a reverse-proxy mount such as /favimg/health.
  if (parsedUrl.pathname === "/health" || parsedUrl.pathname.endsWith("/health")) {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  const domain = (parsedUrl.searchParams.get("url") || "").trim();
  if (domain) {
    await serveFavicon(req, res, domain);
    return;
  }

  // The same handler can be mounted at / or behind a prefix such as /favimg/.
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

async function serveFavicon(req, res, domain) {
  if (domain.length > 512 || domain.includes("\n") || domain.includes("\r")) {
    sendJson(res, 400, { error: "Invalid URL" });
    return;
  }

  try {
    const result = await getFavicon(domain);
    const etag = generateETag(result.buffer);

    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": result.contentType,
      "Content-Length": result.buffer.length,
      "X-Favicon-Source": result.sourceUrl,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(result.buffer);
  } catch (error) {
    const message = error.message || "Failed to fetch favicon";
    const status = error.code === "PRIVATE_ADDRESS" ? 403
      : error.code === "INVALID_URL" ? 400
      : error.code === "DNS_ERROR" ? 404
      : 502;
    sendJson(res, status, { error: message });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = createServer(handle);

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`favicon-api running at http://localhost:${PORT}`);
  });
}
