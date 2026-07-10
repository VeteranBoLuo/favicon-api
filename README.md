<div align="center">

# favicon-api

**一行 URL,拿到任意网站的 favicon。**

<img src="https://img.shields.io/github/stars/VeteranBoLuo/favicon-api?style=for-the-badge&color=615ced" alt="stars">
<img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
<img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge" alt="zero dependency">
<img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT">

<a href="https://boluo66.top/favimg/?url=github.com"><img src="https://img.shields.io/badge/🚀_在线_Demo-615ced?style=for-the-badge&logoColor=white" alt="demo"></a>

简体中文 | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

</div>

---

一个零依赖的 Node.js favicon 获取服务。给它一个域名,返回该网站的图标——**连 Cloudflare 类强反爬站点也能拿到真实图标**。

```bash
curl "https://boluo66.top/favimg/?url=github.com" -o github.png
```

## ✨ 特性

- 🎯 **一个请求搞定** —— `/?url=example.com` 直接返回图标,裸域名自动补 `https://`
- 🧩 **多级兜底** —— 抓网页 `<link rel=icon>` → 退回 `/favicon.ico` → 公网聚合源;目标站强反爬(403)也能拿到真 logo
- ✅ **图标有效性校验** —— 按文件头(magic bytes)识别真图,**拒绝 1×1 透明占位、HTML 假图、聚合源的默认占位**(很多 favicon 服务栽在这)
- 🛡️ **SSRF 防护** —— 解析主机所有 IP,拦截内网 / 回环 / 云元数据(`169.254.169.254`);每一跳重定向都重新校验
- ⚡ **快** —— 抓取超时分级(网页 4s / 图片 6s,慢站快速降级)+ 内存缓存(1h TTL)+ 内容哈希 ETag(命中即 304)
- 📦 **零依赖** —— 只用 Node 内置模块,`node src/index.js` 即可跑

## 🚀 快速开始

```bash
git clone https://github.com/VeteranBoLuo/favicon-api.git
cd favicon-api
npm start          # 默认 http://localhost:3456
```

```bash
curl "http://localhost:3456/?url=github.com" -o github.png
```

在线体验:<https://boluo66.top/favimg/?url=github.com>

## 📖 API

### `GET /?url=<domain>&size=<n>`

| 参数 | 说明 |
|------|------|
| `url` | 域名或完整 URL(如 `github.com`、`https://github.com/x`);裸域名自动补 `https://` |
| `size` | 可选,期望尺寸(像素),仅作提示回写到响应头 |

- **成功**:返回图片二进制,带 `Content-Type: image/*`、`Cache-Control`、`ETag`;命中 `If-None-Match` 返回 `304`
- **失败**:返回 JSON `{ "error": "..." }`,状态码 `403`(拒绝内网/被拒) / `404`(无法解析) / `502`(上游失败)

### `GET /health`

```json
{ "status": "ok" }
```

## ⚙️ 工作原理

1. 抓目标站 HTML,按优先级 + 尺寸解析出最佳 `<link rel="icon">`;拿不到就退回 `<origin>/favicon.ico`
2. **校验抓到的确实是图片**(PNG/ICO/JPEG/GIF/WebP/SVG 文件头),并排除 1×1 占位
3. 直连失败(强反爬 403 / 无 favicon / 超时)→ **兜底公网图标聚合源**,并按内容哈希跳过其"没有 logo 时的默认占位图"
4. 结果进内存缓存(条目上限 LRU 淘汰 + 1h TTL),配内容哈希 ETag 支持 304 协商缓存

## 🛠️ 部署

```bash
node src/index.js
# 或指定端口
PORT=8080 node src/index.js
```

任意进程守护(pm2 / systemd / docker)都可,零依赖、无需构建。

## 📄 License

[MIT](LICENSE) © VeteranBoLuo
