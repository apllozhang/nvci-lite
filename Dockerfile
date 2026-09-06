# alpine 底座 + downloader.js 的 undici c-ares lookup：规避 musl 对
# 「AAAA NXDOMAIN / 超长 CNAME 链」的 DNS 缺陷（曾致 download.h3c.com 全量 fetch failed）
FROM node:20-alpine
# poppler-utils 提供 pdftoppm：视觉兜底抽取时把 PDF 页面渲染为 JPEG
RUN apk add --no-cache poppler-utils
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV PORT=8788 NVCI_LITE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=10s CMD wget -qO- http://127.0.0.1:8788/api/session >/dev/null || exit 1
CMD ["node", "server.js"]
