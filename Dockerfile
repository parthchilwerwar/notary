# syntax=docker/dockerfile:1.7
# Notary hosted API + agents image (docs/DEPLOY_AWS.md). Two stages:
#   deps     installs @notary/core's dependencies with the pinned pnpm from the lockfile
#   runtime  source + node_modules + the staged real run records; runs as the unprivileged `node` user
# Default command: the hosted, read-only API (src/hosted-main.ts) on :8080. The same image runs the
# batch agents (`notary notarize` / `notary run`) as ECS tasks with a command override.
# No secret is ever baked in: .env is excluded by .dockerignore and every key arrives at runtime from
# AWS Secrets Manager through the ECS task definition.
# Pin: Node 22 LTS (node:sqlite without a flag needs >= 22.13). For production, pin by digest too:
#   docker buildx imagetools inspect node:22.20.0-bookworm-slim
ARG NODE_IMAGE=node:22.20.0-bookworm-slim
ARG PNPM_VERSION=11.7.0

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# Manifests first (cached layer). Every workspace manifest is copied so the frozen lockfile matches;
# only @notary/core's dependency tree is installed (dev deps included: tsx and typescript run the TS
# source and the guard-coverage walk at runtime).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/showreel/package.json packages/showreel/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @notary/core

FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
    PORT=8080 \
    NOTARY_RUNS_DIR=/app/data/runs \
    NOTARY_BUNDLES_DIR=/app/packages/web/public/bundles \
    NOTARY_MODE=test
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/web/public/bundles ./packages/web/public/bundles
COPY deploy/aws/data ./data
# The API writes only its chat store and spans under the runs dir; the agents task writes bundles there.
RUN mkdir -p /app/data/runs /app/packages/core/runs && chown -R node:node /app/data /app/packages/core/runs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "packages/core/src/hosted-main.ts"]
