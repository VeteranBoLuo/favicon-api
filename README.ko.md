<div align="center">

<img src="public/favicon.svg" width="88" height="88" alt="favicon-api 로고">

# favicon-api

**URL 하나로 모든 사이트의 favicon 가져오기.**

<img src="https://img.shields.io/github/stars/VeteranBoLuo/favicon-api?style=for-the-badge&color=615ced" alt="stars">
<img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
<img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge" alt="zero dependency">
<img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT">

<a href="https://boluo66.top/favimg/"><img src="https://img.shields.io/badge/🚀_라이브_데모-615ced?style=for-the-badge&logoColor=white" alt="demo"></a>

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · 한국어

</div>

---

의존성 제로 Node.js favicon 취득 서비스. 도메인을 넘기면 해당 사이트의 아이콘을 반환합니다 — **Cloudflare 계열 안티봇 사이트에서도 실제 아이콘을 가져옵니다**.

```bash
curl "https://boluo66.top/favimg/?url=github.com" -o github.png
```

## ✨ 특징

- 🎯 **요청 한 번** — `/?url=github.com` 으로 아이콘 반환. 도메인만 넣으면 `https://` 자동 추가
- 🧩 **다단계 폴백** — 페이지의 `<link rel=icon>` → `/favicon.ico` → 공개 애그리게이터. 대상이 봇을 차단(403)해도 실제 로고 취득
- ✅ **아이콘 유효성 검사** — 매직 바이트로 진짜 이미지를 판별하고 **1×1 투명 플레이스홀더, HTML 위장, 애그리게이터의 기본 플레이스홀더를 걸러냄**(많은 favicon 서비스가 놓치는 부분)
- 🛡️ **SSRF 방어** — 호스트의 모든 IP를 해석해 사설 / 루프백 / 클라우드 메타데이터(`169.254.169.254`)를 차단. 리다이렉트 매 홉마다 재검증
- ⚡ **빠름** — 단계별 타임아웃(HTML 4s / 이미지 6s, 느린 사이트는 즉시 폴백) + 메모리 캐시(1h TTL) + 콘텐츠 해시 ETag(히트 시 304)
- 📦 **의존성 제로** — Node 내장 모듈만 사용. `node src/index.js` 로 실행

## 🚀 빠른 시작

```bash
git clone https://github.com/VeteranBoLuo/favicon-api.git
cd favicon-api
npm start          # 기본 http://localhost:3456
```

```bash
curl "http://localhost:3456/?url=github.com" -o github.png
```

라이브 데모: <https://boluo66.top/favimg/> · API 예시: <https://boluo66.top/favimg/?url=github.com>

## 📖 API

### `GET /?url=<domain>`

| 파라미터 | 설명 |
|---------|------|
| `url` | 도메인 또는 전체 URL(`github.com`, `https://github.com/x`). 도메인만 넣으면 `https://` 자동 추가 |

- **성공**: 이미지 바이너리 반환(`Content-Type: image/*`, `Cache-Control`, `ETag`). `If-None-Match` 일치 시 `304`
- **실패**: JSON `{ "error": "..." }`. `403`(차단/내부) / `404`(해석 불가) / `502`(업스트림 실패)

### `GET /health`

```json
{ "status": "ok" }
```

## ⚙️ 작동 원리

1. 대상 HTML을 가져와 우선순위 + 크기로 최적의 `<link rel="icon">` 파싱. 없으면 `<origin>/favicon.ico` 로 폴백
2. **결과가 정말 이미지인지 검증**(PNG/ICO/JPEG/GIF/WebP/SVG 헤더)하고 1×1 플레이스홀더 제외
3. 직접 취득 실패(안티봇 403 / favicon 없음 / 타임아웃) 시 → **공개 아이콘 애그리게이터로 폴백**하며 "로고 없을 때의 기본 플레이스홀더"를 콘텐츠 해시로 건너뜀
4. 결과를 상한이 있는 메모리 캐시(1h TTL)에 저장하고 콘텐츠 해시 ETag로 304 재검증 지원

## 🛠️ 배포

```bash
node src/index.js
# 포트 지정
PORT=8080 node src/index.js
```

pm2 / systemd / docker 등 임의의 프로세스 매니저에서 동작. 의존성 제로, 빌드 불필요.

## 📄 라이선스

[MIT](LICENSE) © VeteranBoLuo
