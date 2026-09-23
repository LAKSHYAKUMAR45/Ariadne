# Hardened production image for @ariadne-dev/sync-server.
#
# Build from the repository root:
#   docker build -f deploy/nodem2/sync-server.Dockerfile -t ariadne-sync-server:<sha> .
#
# Stage 1 installs dev dependencies and compiles TypeScript; stage 2 contains
# only production dependencies, compiled JavaScript, and migrations — no pnpm
# store, compilers, or other build tooling.
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
WORKDIR /repo

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/sync-server/package.json packages/sync-server/package.json

RUN pnpm install --frozen-lockfile --filter @ariadne-dev/sync-server...

COPY packages/sync-server packages/sync-server

RUN pnpm --filter @ariadne-dev/sync-server run build \
    && pnpm deploy --legacy --filter @ariadne-dev/sync-server --prod /app \
    && rm -rf /app/src /app/test /app/tsconfig.json /app/vitest.config.ts

FROM node:20-bookworm-slim AS runtime

# setpriv (util-linux) performs the permanent privilege drop in the entrypoint.
RUN set -eux; \
    command -v setpriv >/dev/null; \
    groupadd --gid 10001 ariadne; \
    useradd --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ariadne

ENV NODE_ENV=production
ENV ARIADNE_APP_UID=10001
ENV ARIADNE_APP_GID=10001
# Keys are handed off from the read-only canonical mount into this tmpfs path.
ENV ENCRYPTION_KEY_DIR=/run/ariadne/keys
ENV HOST=0.0.0.0
ENV PORT=4300

WORKDIR /app
COPY --from=builder --chown=root:root /app /app
COPY --chown=root:root deploy/nodem2/scripts/sync-server-entrypoint /usr/local/bin/sync-server-entrypoint
RUN chmod 0755 /usr/local/bin/sync-server-entrypoint

EXPOSE 4300

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4300) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/sync-server-entrypoint"]
CMD ["node", "/app/dist/index.js"]
