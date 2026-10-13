# syntax=docker/dockerfile:1.7
#
# LLM Wiki runtime image.
#
# Deployment contract (see docs/16-docker-deployment.md):
#
#   The image ships a WARMED PNPM STORE plus node_modules compiled against THIS
#   image's Node ABI — it does NOT ship the application source. Source is bind
#   mounted from the host at run time, so publishing an update is:
#
#       overwrite files in ./app on the host (FTP/SCP/git pull)
#       -> docker compose up -d --force-recreate wiki
#
#   No tarball, no unpack step, no image rebuild on update.
#
# Why node_modules must NOT come from the host:
#   better-sqlite3 and keytar are native modules whose ABI is bound to the Node
#   major they were compiled for. A node_modules tree produced on a Windows or
#   macOS dev box (or by a different Node major) is unusable inside the
#   container, so those directories are masked by named volumes below (in
#   docker-compose.yml) and installed in-container instead.

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-bookworm-slim

# Where the application source lives INSIDE THE BUILD CONTEXT.
#
# The build context is always the source root:
#   server:  /srv/llm-wiki/app   (files uploaded there directly)
#   dev box: llm-wiki/           (a plain checkout)
# Either way the source is at the context root, hence "." — and every COPY below
# is prefixed with ${APP_SRC} so a different layout only needs this one value.
ARG APP_SRC=.

# NOTE: NODE_ENV is deliberately NOT set here. pnpm skips devDependencies when
# NODE_ENV=production, and the build (typescript, @types/*, ...) needs them.
# The runtime gets NODE_ENV=production from docker-compose.yml instead.
ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1 \
    NO_UPDATE_NOTIFIER=1 \
    PNPM_HOME=/root/.local/share/pnpm \
    TZ=Asia/Shanghai

# libsecret-1-0 : keytar's runtime shared library. keytar degrades to
#                 file-backed secrets when no keyring daemon is running (normal
#                 in containers), but a missing .so is a hard load failure.
# python3/make/g++ : native build toolchain for better-sqlite3 + keytar.
#                    Kept in the final image on purpose: the entrypoint may
#                    need to (re)install deps after a lockfile change.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libsecret-1-0 \
      python3 \
      make \
      g++ \
 && rm -rf /var/lib/apt/lists/*

# Pin the package manager to the version in package.json#packageManager so the
# container resolves the workspace exactly like CI does.
RUN corepack enable \
 && corepack prepare pnpm@10.12.1 --activate

WORKDIR /app

# ---- dependency layer ------------------------------------------------------
# Manifests only. `pnpm fetch` resolves the lockfile and downloads every
# tarball into the store without creating node_modules, so this layer stays
# valid across unlimited source updates.
COPY ${APP_SRC}/pnpm-workspace.yaml ${APP_SRC}/package.json ${APP_SRC}/pnpm-lock.yaml ./
COPY ${APP_SRC}/packages/core/package.json       packages/core/
COPY ${APP_SRC}/packages/llm/package.json        packages/llm/
COPY ${APP_SRC}/packages/ingestion/package.json  packages/ingestion/
COPY ${APP_SRC}/apps/web/package.json            apps/web/

RUN pnpm fetch

# ---- build layer -----------------------------------------------------------
# Build-time proxy escape hatch. `next/font/google` hits fonts.googleapis.com
# during `next build`, which fails on hosts without outbound access (common on
# CN servers). ARG values are exposed to RUN as env vars but are NOT baked into
# the final image, so the runtime stays proxy-free.
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""

# Source lands in the image only so the dependency tree is complete; at run
# time the host bind mount overwrites it. Seeding node_modules here means a
# fresh named volume is populated by Docker at first start (no install wait).
COPY ${APP_SRC}/packages/ packages/
COPY ${APP_SRC}/apps/ apps/

# --offline proves the warm store is complete: a missing tarball fails here,
# during build, instead of during a restart on the server.
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @llm-wiki/web build

COPY ${APP_SRC}/docker-entrypoint.sh /usr/local/bin/entrypoint.sh

# Strip CRLF before making it executable.
#
# The entrypoint travels to the server as an ordinary file (FTP upload,
# git checkout), so it can arrive with Windows line endings. A stray \r breaks
# the shebang — the kernel looks for `/usr/bin/env "bash\r"` and the container
# dies instantly with `exec: not found`, which reads as a broken image rather
# than a line-ending mistake. Normalising here means no upload mode, FTP
# client setting or .gitattributes rule can reintroduce it.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
 && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3737

# Default: production server. Set WIKI_MODE=dev to run `next dev` instead
# (no build step, compile on demand) — see docs.
ENV WIKI_MODE=prod

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/apps/web/node_modules/next/dist/bin/next", "start", "-p", "3737", "-H", "0.0.0.0"]
