<div align="center">

<img src="public/favicon.svg" width="88" height="88" alt="favicon-api ロゴ">

# favicon-api

**URL 一つで、あらゆるサイトの favicon を取得。**

<img src="https://img.shields.io/github/stars/VeteranBoLuo/favicon-api?style=for-the-badge&color=615ced" alt="stars">
<img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
<img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge" alt="zero dependency">
<img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT">

<a href="https://boluo66.top/favimg/"><img src="https://img.shields.io/badge/🚀_ライブデモ-615ced?style=for-the-badge&logoColor=white" alt="demo"></a>

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語 · [한국어](README.ko.md)

</div>

---

依存ゼロの Node.js 製 favicon 取得サービス。ドメインを渡すとそのサイトのアイコンを返します — **Cloudflare 系のアンチボットサイトでも実アイコンを取得できます**。

```bash
curl "https://boluo66.top/favimg/?url=github.com" -o github.png
```

## ✨ 特徴

- 🎯 **リクエスト一つ** — `/?url=github.com` でアイコンを返却。裸のドメインには自動で `https://` を付与
- 🧩 **多段フォールバック** — ページの `<link rel=icon>` → `/favicon.ico` → 公開アグリゲータ。対象がボットを拒否(403)しても実ロゴを取得
- ✅ **アイコンの妥当性チェック** — マジックバイトで本物の画像を判定し、**1×1 透明プレースホルダ・HTML の偽装・アグリゲータの既定プレースホルダを除外**(多くの favicon サービスが見落とす点)
- 🛡️ **SSRF 対策** — ホストの全 IP を解決し、プライベート / ループバック / クラウドメタデータ(`169.254.169.254`)を遮断。リダイレクトの各ホップで再検証
- ⚡ **高速** — 段階的タイムアウト(HTML 4s / 画像 6s、遅いサイトは即フォールバック)+ メモリキャッシュ(1h TTL)+ 内容ハッシュ ETag(ヒット時 304)
- 📦 **依存ゼロ** — Node 標準モジュールのみ。`node src/index.js` で起動

## 🚀 クイックスタート

```bash
git clone https://github.com/VeteranBoLuo/favicon-api.git
cd favicon-api
npm start          # 既定 http://localhost:3456
```

```bash
curl "http://localhost:3456/?url=github.com" -o github.png
```

ライブデモ: <https://boluo66.top/favimg/> · API 例: <https://boluo66.top/favimg/?url=github.com>

## 📖 API

### `GET /?url=<domain>`

| パラメータ | 説明 |
|-----------|------|
| `url` | ドメインまたは完全な URL(`github.com`、`https://github.com/x`)。裸のドメインは `https://` を自動付与 |

- **成功**: 画像バイナリを返却(`Content-Type: image/*`、`Cache-Control`、`ETag`)。`If-None-Match` 一致時は `304`
- **失敗**: JSON `{ "error": "..." }`。`403`(拒否/内部) / `404`(解決不可) / `502`(上流エラー)

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /stats`

成功した favicon リクエスト数を返します。体験ページが自動表示するサンプルは集計しません。

```json
{ "count": 12001 }
```

## ⚙️ 仕組み

1. 対象の HTML を取得し、優先度 + サイズで最適な `<link rel="icon">` を解析。取れなければ `<origin>/favicon.ico` にフォールバック
2. **取得結果が本当に画像か検証**(PNG/ICO/JPEG/GIF/WebP/SVG のヘッダー)し、1×1 プレースホルダを除外
3. 直接取得に失敗(アンチボット 403 / favicon なし / タイムアウト)した場合 → **公開アイコンアグリゲータにフォールバック**し、「ロゴ無し時の既定プレースホルダ」を内容ハッシュでスキップ
4. 結果を上限付きメモリキャッシュ(1h TTL)に保存し、内容ハッシュ ETag で 304 再検証に対応

## 🛠️ デプロイ

```bash
node src/index.js
# ポート指定
PORT=8080 node src/index.js

# 利用回数を再起動後も保持し、既存の実数を初期値に設定
FAVICON_USAGE_COUNT_FILE=./data/usage-count.json \
FAVICON_USAGE_COUNT_START=12000 node src/index.js
```

pm2 / systemd / docker など任意のプロセス管理で動作。依存ゼロ、ビルド不要。

## 📄 ライセンス

[MIT](LICENSE) © VeteranBoLuo
