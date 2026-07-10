<div align="center">

# favicon-api

**Get any website's favicon with a single URL.**

<img src="https://img.shields.io/github/stars/VeteranBoLuo/favicon-api?style=for-the-badge&color=615ced" alt="stars">
<img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
<img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge" alt="zero dependency">
<img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT">

<a href="https://boluo66.top/favimg/?url=github.com"><img src="https://img.shields.io/badge/🚀_Live_Demo-615ced?style=for-the-badge&logoColor=white" alt="demo"></a>

[简体中文](README.md) | English | [日本語](README.ja.md) | [한국어](README.ko.md)

</div>

---

A zero-dependency Node.js favicon service. Give it a domain, get the site's icon back — **even for Cloudflare-style anti-bot sites**.

```bash
curl "https://boluo66.top/favimg/?url=github.com" -o github.png
```

## ✨ Features

- 🎯 **One request** — `/?url=example.com` returns the icon; bare domains get `https://` prepended automatically
- 🧩 **Multi-source fallback** — page `<link rel=icon>` → `/favicon.ico` → public aggregators; still gets the real logo even when the target blocks bots (403)
- ✅ **Icon validity check** — detects real images by magic bytes and **rejects 1×1 transparent placeholders, HTML fake-outs, and aggregators' default placeholder** (where many favicon services quietly fail)
- 🛡️ **SSRF protection** — resolves all host IPs, blocks private / loopback / cloud-metadata (`169.254.169.254`); re-checked on every redirect hop
- ⚡ **Fast** — tiered fetch timeouts (HTML 4s / image 6s, fast-fail to fallback) + in-memory cache (1h TTL) + content-hash ETag (304 on hit)
- 📦 **Zero dependencies** — Node built-ins only; just `node src/index.js`

## 🚀 Quick start

```bash
git clone https://github.com/VeteranBoLuo/favicon-api.git
cd favicon-api
npm start          # default http://localhost:3456
```

```bash
curl "http://localhost:3456/?url=github.com" -o github.png
```

Live demo: <https://boluo66.top/favimg/?url=github.com>

## 📖 API

### `GET /?url=<domain>&size=<n>`

| Param | Description |
|-------|-------------|
| `url` | Domain or full URL (`github.com`, `https://github.com/x`); bare domains get `https://` prepended |
| `size` | Optional; desired size (px), written back to the response header as a hint |

- **Success**: image binary with `Content-Type: image/*`, `Cache-Control`, `ETag`; returns `304` on matching `If-None-Match`
- **Failure**: JSON `{ "error": "..." }` with `403` (blocked / private) / `404` (unresolvable) / `502` (upstream failed)

### `GET /health`

```json
{ "status": "ok" }
```

## ⚙️ How it works

1. Fetch the target's HTML and parse the best `<link rel="icon">` by priority + size; fall back to `<origin>/favicon.ico`
2. **Validate the result is really an image** (PNG/ICO/JPEG/GIF/WebP/SVG headers) and reject 1×1 placeholders
3. On direct-fetch failure (anti-bot 403 / no favicon / timeout) → **fall back to public icon aggregators**, skipping their "no-logo default placeholder" by content hash
4. Cache in memory (LRU cap + 1h TTL) with a content-hash ETag for 304 revalidation

## 🛠️ Deployment

```bash
node src/index.js
# or a custom port
PORT=8080 node src/index.js
```

Runs under any process manager (pm2 / systemd / docker) — zero deps, no build step.

## 📄 License

[MIT](LICENSE) © VeteranBoLuo
