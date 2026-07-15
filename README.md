<div align="center">

<img src="public/favicon.svg" width="88" height="88" alt="favicon-api logo">

# favicon-api

**Any site's favicon. One simple URL.**

[![CI](https://github.com/VeteranBoLuo/favicon-api/actions/workflows/ci.yml/badge.svg)](https://github.com/VeteranBoLuo/favicon-api/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[**Try the live demo →**](https://boluo66.top/favimg/) · [View an API response](https://boluo66.top/favimg/?url=github.com)

English · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

A small, self-hosted Node.js API that discovers real website icons, rejects fake placeholders, and falls back to public icon sources when direct requests fail.

```html
<img src="https://boluo66.top/favimg/?url=github.com" alt="GitHub">
```

<div align="center">
  <img src="https://boluo66.top/favimg/?url=baidu.com" width="56" height="56" alt="Baidu favicon">&nbsp;&nbsp;
  <img src="https://boluo66.top/favimg/?url=bilibili.com" width="56" height="56" alt="Bilibili favicon">&nbsp;&nbsp;
  <img src="https://boluo66.top/favimg/?url=github.com" width="56" height="56" alt="GitHub favicon">&nbsp;&nbsp;
  <img src="https://boluo66.top/favimg/?url=google.com" width="56" height="56" alt="Google favicon">
</div>

## Why favicon-api?

- **One request** — `/?url=github.com` returns an image; bare domains automatically use HTTPS.
- **Resilient discovery** — page icon metadata → `/favicon.ico` → public fallback sources.
- **Real-image validation** — rejects HTML responses, 1×1 pixels, and known provider placeholders.
- **SSRF protection** — blocks private and reserved addresses before the initial request and every redirect hop.
- **HTTP caching** — in-memory TTL cache, bounded eviction, content-based ETags, and `304` responses.
- **Zero dependencies** — runs on Node.js built-ins with no install or build step.

## Tested from mainland China

On 2026-07-15, all 12 major Chinese sites and 36 international sites in our sample returned valid images from a mainland China server. The first 28 results all had unique content hashes, so they were not a shared default placeholder. Chinese sites usually work directly; international sites rely more heavily on fallback providers. A cold request for sites such as Google, YouTube, X, or Facebook can take about 10 seconds, while cached responses usually return in tens of milliseconds.

## Quick start

```bash
git clone https://github.com/VeteranBoLuo/favicon-api.git
cd favicon-api
npm start
```

Open <http://localhost:3456> for the interactive playground, or request an icon directly:

```bash
curl "http://localhost:3456/?url=github.com" -o github.svg
```

The public usage total is kept in memory by default. Set a writable file path to persist it across restarts; `FAVICON_USAGE_COUNT_START` can seed an existing historical total:

```bash
FAVICON_USAGE_COUNT_FILE=./data/usage-count.json \
FAVICON_USAGE_COUNT_START=12000 npm start
```

### Docker

```bash
docker build -t favicon-api .
docker run --rm -p 3456:3456 favicon-api
```

## API

### `GET /?url=<domain-or-url>`

```text
https://boluo66.top/favimg/?url=github.com
https://boluo66.top/favimg/?url=https%3A%2F%2Fgithub.com%2Fopenai
```

Successful responses contain the image binary and these useful headers:

| Header | Description |
| --- | --- |
| `Content-Type` | Detected image type |
| `Cache-Control` | Browser and CDN cache policy |
| `ETag` | Content-based validator; supports `If-None-Match` |
| `X-Favicon-Source` | Final source URL after redirects or fallback |

Errors use JSON: `{ "error": "..." }` with `400`, `403`, `404`, or `502` status codes.

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /stats`

Returns the number of qualified, successful favicon fetches. Built-in playground previews are excluded.

```json
{ "count": 12001 }
```

The public total counts the same client and normalized hostname at most once every 30 minutes; different hostnames still count, so legitimate bulk imports remain represented. After 3,000 distinct hostnames from one client within 10 minutes, only the public counter pauses — API responses continue normally. Set `FAVICON_TRUST_PROXY=1` only behind a proxy that overwrites `X-Real-IP`; `FAVICON_USAGE_TRUSTED_IPS` can exempt trusted first-party importers from the extreme burst threshold.

## How it works

1. Normalize the input URL and reject private or reserved destinations.
2. Fetch the page with a short timeout and manually validate every redirect destination.
3. Select the best icon declared by the page, otherwise try `/favicon.ico`.
4. Validate the image signature and reject tiny or known placeholder images.
5. Try public fallback sources when direct discovery fails, then cache the valid result.

## Security and privacy

This service fetches user-supplied public URLs. It blocks private, loopback, link-local, documentation, and other reserved address ranges; limits redirect hops and response sizes; and re-checks each redirect destination. DNS rebinding cannot be eliminated completely without pinning DNS resolution to the outbound connection, so use additional egress controls for high-trust production environments.

Fallback requests may send the requested hostname to `favicone.com` or Yandex. Remove or replace `AGGREGATOR_BUILDERS` in [`src/favicon.js`](src/favicon.js) if your environment must avoid third-party services.

## Development

```bash
npm test
npm run check
```

Contributions and reproducible edge cases are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © VeteranBoLuo
