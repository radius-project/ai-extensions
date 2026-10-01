# syntax=docker/dockerfile:1
ARG QUALIFICATION_BASE=radius-canvas-visual:playwright-1.62.1-node-24.19.0
FROM ghcr.io/headlamp-k8s/headlamp:v0.45.0@sha256:db3f0e0fc58d358d41daa3fe7fc852437552c7ee873c3645470f7b86a8e0db49 AS headlamp
FROM ${QUALIFICATION_BASE}

COPY --from=headlamp /headlamp/headlamp-server /headlamp/headlamp-server
COPY --from=headlamp /headlamp/frontend /headlamp/frontend

WORKDIR /workspace/scripts/fixtures/headlamp
# Direct dependencies are pinned in package.json. Transitive dependencies are
# resolved at build time, and qualify.mjs saves the resolved lockfile.
COPY package.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm install --ignore-scripts --no-audit --no-fund
COPY . .
WORKDIR /workspace
