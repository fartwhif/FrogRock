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
RUN apk add --no-cache ffmpeg
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
USER appuser
EXPOSE 8090
CMD ["node", "dist/server.js"]
