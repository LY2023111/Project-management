FROM node:22-alpine
WORKDIR /app

# 先装依赖（利用镜像层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 再拷贝代码
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 5200
CMD ["node", "server/index.js"]
