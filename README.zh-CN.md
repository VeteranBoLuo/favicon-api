<div align="center">

<img src="public/favicon.svg" width="88" height="88" alt="favicon-api 标志">

# favicon-api

**一个 URL，获取任意网站的 favicon。**

[![CI](https://github.com/VeteranBoLuo/favicon-api/actions/workflows/ci.yml/badge.svg)](https://github.com/VeteranBoLuo/favicon-api/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![依赖](https://img.shields.io/badge/dependencies-0-brightgreen)
[![许可证](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[**在线体验 →**](https://boluo66.top/favimg/) · [查看 API 示例](https://boluo66.top/favimg/?url=github.com)

[English](README.md) · 简体中文 · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

一个小巧、可自托管的 Node.js API：自动发现网站真实图标，过滤假图和占位图，直连失败时使用公共图标源兜底。

```html
<img src="https://boluo66.top/favimg/?url=github.com" alt="GitHub">
```

<div align="center">
  <img src="https://boluo66.top/favimg/?url=baidu.com" width="56" height="56" alt="百度 favicon">&nbsp;&nbsp;
  <img src="https://boluo66.top/favimg/?url=bilibili.com" width="56" height="56" alt="哔哩哔哩 favicon">&nbsp;&nbsp;
  <img src="https://boluo66.top/favimg/?url=github.com" width="56" height="56" alt="GitHub favicon">&nbsp;&nbsp;
  <img src="https://boluo66.top/favimg/?url=google.com" width="56" height="56" alt="Google favicon">
</div>

## 为什么选择 favicon-api？

- **一次请求** —— `/?url=github.com` 直接返回图片，裸域名自动使用 HTTPS。
- **多级发现** —— 页面图标声明 → `/favicon.ico` → 公共兜底源。
- **真实图片校验** —— 拒绝 HTML 假图、1×1 像素和已知的服务商默认占位图。
- **SSRF 防护** —— 首次请求及每一跳重定向前，都会拦截内网与保留地址。
- **HTTP 缓存** —— 有界内存缓存、TTL、内容哈希 ETag 与 `304` 响应。
- **零依赖** —— 只使用 Node.js 内置模块，无需安装依赖或构建。

## 中国大陆服务器实测

2026-07-15 从中国大陆服务器测试：12 个主流中国网站与 36 个海外网站均成功返回有效图片；首批 28 个结果的内容哈希全部不同，没有返回同一张默认占位图。中国网站多数可以直连，海外网站更常依赖兜底源；Google、YouTube、X、Facebook 等首次请求可能需要约 10 秒，缓存命中后通常只需几十毫秒。

## 快速开始

```bash
git clone https://github.com/VeteranBoLuo/favicon-api.git
cd favicon-api
npm start
```

打开 <http://localhost:3456> 使用交互式体验页，或直接请求图标：

```bash
curl "http://localhost:3456/?url=github.com" -o github.svg
```

### Docker

```bash
docker build -t favicon-api .
docker run --rm -p 3456:3456 favicon-api
```

## API

### `GET /?url=<域名或URL>`

```text
https://boluo66.top/favimg/?url=github.com
https://boluo66.top/favimg/?url=https%3A%2F%2Fgithub.com%2Fopenai
```

成功响应返回图片二进制，并包含：

| 响应头 | 说明 |
| --- | --- |
| `Content-Type` | 检测到的图片类型 |
| `Cache-Control` | 浏览器与 CDN 缓存策略 |
| `ETag` | 基于内容生成，支持 `If-None-Match` |
| `X-Favicon-Source` | 重定向或兜底后的最终来源 URL |

失败时返回 JSON：`{ "error": "..." }`，状态码为 `400`、`403`、`404` 或 `502`。

### `GET /health`

```json
{ "status": "ok" }
```

## 工作原理

1. 标准化输入 URL，并拒绝内网和保留地址。
2. 短超时抓取网页，手动处理并逐跳检查重定向目的地。
3. 选择网页声明的最佳图标；没有声明时尝试 `/favicon.ico`。
4. 按文件特征验证图片，过滤过小图片与已知占位图。
5. 直连失败时尝试公共兜底源，然后缓存有效结果。

## 安全与隐私

服务会访问用户提交的公开 URL。它会拦截内网、回环、链路本地、文档示例等保留地址，限制重定向次数与响应大小，并重新检查每一个重定向目的地。若生产环境安全等级较高，仍建议配置网络出口规则，以进一步降低 DNS rebinding 风险。

兜底请求可能把目标域名发送给 `favicone.com` 或 Yandex。如果你的环境不能使用第三方服务，可以在 [`src/favicon.js`](src/favicon.js) 中删除或替换 `AGGREGATOR_BUILDERS`。

## 开发

```bash
npm test
npm run check
```

欢迎贡献代码和可复现的边界案例，参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © VeteranBoLuo
