# syntax=docker/dockerfile:1
# Website Mover: the web app and the queue worker (docs/m4/design.md).
#   docker compose --profile app up -d --build

FROM node:22.22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# Workspace install (all packages are TypeScript source; the worker runs them with tsx).
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# ---- worker ----
FROM deps AS worker
# poppler-utils: style guide PDF facts (pdfinfo, pdftotext, pdffonts, pdfimages, pdftoppm).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
# Chromium for the QA stage (Playwright + axe-core), in a folder the node user can read.
# Chromium's own sandbox can't start in a container without extra privileges (tested): the container is
# the boundary, and every request the browser makes still goes through the SSRF check.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright WM_CHROMIUM_NO_SANDBOX=1
RUN pnpm --filter @wm/qa exec playwright install --with-deps chromium
ENV NODE_ENV=production WM_DATA_DIR=/data
USER node
CMD ["node", "--import", "tsx", "apps/worker/src/worker.ts"]

# ---- web ----
FROM deps AS web-build
RUN pnpm --filter @wm/web build

FROM base AS web
ENV NODE_ENV=production WM_DATA_DIR=/data PORT=3100 HOSTNAME=0.0.0.0
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
