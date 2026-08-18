# Build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY types/ ./types/
COPY src/ ./src/
COPY server.ts ./
RUN npx tsc --skipLibCheck

# Runtime stage
FROM node:22-bookworm-slim
WORKDIR /app
ENV PORT=8090
ENV CACHE_DIR=/cache
RUN apt-get update && apt-get install -y --no-install-recommends \
    wireguard \
    iproute2 \
    sudo \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r appgroup && useradd -r -g appgroup -d /app -s /sbin/nologin appuser \
    && mkdir -p /etc/wireguard
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY public/ ./public/
COPY wireguard/wg0.conf.template /etc/wireguard/wg0.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8090
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]
