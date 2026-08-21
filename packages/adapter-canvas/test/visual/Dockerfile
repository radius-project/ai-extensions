FROM node:24.19.0-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848 AS node-runtime

FROM mcr.microsoft.com/playwright:v1.62.1-noble-amd64@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac

COPY --from=node-runtime /usr/local/ /usr/local/

ENV CI=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspace

RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN chmod a+w packages/adapter-canvas/test/e2e
