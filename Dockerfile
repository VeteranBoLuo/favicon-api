FROM node:20-alpine

WORKDIR /app
COPY package.json LICENSE ./
COPY public ./public
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3456/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node
CMD ["node", "src/index.js"]
