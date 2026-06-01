# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY types/ ./types/
COPY src/ ./src/
COPY server.ts ./
RUN npx tsc --skipLibCheck

# Runtime stage
FROM node:22-alpine
WORKDIR /app
ENV PORT=8090
ENV CACHE_DIR=/cache
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && apk add --no-cache wireguard-tools iproute2 su-exec \
    && mkdir -p /etc/wireguard
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY wireguard/wg0.conf.template /etc/wireguard/wg0.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8090
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]
