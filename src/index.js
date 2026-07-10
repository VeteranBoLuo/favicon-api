import { createServer } from "node:http";
import { getFavicon, generateETag } from "./favicon.js";

const PORT = parseInt(process.env.PORT || "3456", 10);

const server = createServer(async (req, res) => {
  // CORS — allow all origins
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Favicon route: ?url=domain&size=N
  const parsedUrl = new URL(req.url, `http://localhost`);
  const domain = (parsedUrl.searchParams.get("url") || "").trim();
  const size = parseInt(parsedUrl.searchParams.get("size") || "0", 10) || 0;

  if (domain) {
    return serveFavicon(req, res, domain, size);
  }

  // 404
  res.setHeader("Content-Type", "application/json");
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Usage: ?url=example.com" }));
});

async function serveFavicon(req, res, domain, size) {
  if (!domain) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing domain. Usage: ?url=example.com" }));
    return;
  }

  if (domain.length > 512 || domain.includes("\n") || domain.includes("\r")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid domain" }));
    return;
  }

  try {
    const result = await getFavicon(domain);
    const etag = generateETag(result.buffer);

    // 内容未变则命中协商缓存,直接 304 空响应(配合按内容哈希的 ETag 才有意义)
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Length", result.buffer.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("ETag", etag);
    res.setHeader("X-Favicon-Source", result.sourceUrl);
    if (size > 0) {
      res.setHeader("X-Favicon-Size", size);
    }
    res.writeHead(200);
    res.end(result.buffer);
  } catch (err) {
    const message = err.message || "Failed to fetch favicon";
    const status = message.includes("拒绝访问") ? 403
      : message.includes("无法解析") || message.includes("Not Found") || message.includes("Enotfound") ? 404
      : 502;

    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify({ error: message }));
  }
}

export const handle = server.listeners('request')[0];
if (import.meta.url === `file://${process.argv[1]}`) server.listen(PORT, () => {
  console.log(`favicon-api running at http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/?url=github.com`);
});
