# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS node-runtime

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

COPY --from=node-runtime /usr/local/ /usr/local/

ENV CI=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
	npm install --global "$(node -p "require('./package.json').packageManager")" && \
	pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN chmod a+w packages/adapter-canvas/test/e2e
