FROM rust:1.89-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN rustup target add wasm32-unknown-unknown \
  && npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=1234

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist

EXPOSE 1234

CMD ["node", "server/index.mjs"]
