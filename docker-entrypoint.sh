#!/usr/bin/env bash
#
# Entrypoint: reconcile the host-mounted source with the image's dependency
# layer, then exec CMD (default: `next start -p 3737 -H 0.0.0.0`).
#
# Both steps are incremental:
#   - `pnpm install` is a no-op when the lockfile already matches node_modules,
#     and resolves from the image's pre-warmed store when it doesn't.
#   - `next build` reuses `.next/cache`, which lives in a named volume.
#
# So the routine update path (unpack sources, `docker compose restart`) costs
# seconds, not minutes.

set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
WEB_DIR="${WEB_DIR:-${APP_DIR}/apps/web}"
MODE="${WIKI_MODE:-prod}"
SKIP_BUILD="${SKIP_BUILD:-0}"

log() { echo "[wiki-entrypoint] $*"; }

cd "$APP_DIR"
log "mode=${MODE} node=$(node -v) pnpm=$(pnpm -v)"

# ---- 1. dependencies ------------------------------------------------------
# Native modules are compiled here, against this container's Node ABI. That is
# why node_modules must never be mounted in from the host.
#
# NODE_ENV=development forces devDependencies to install: NODE_ENV=production
# reaches this script from docker-compose.yml, and pnpm would then skip them —
# but `next build` needs the toolchain (typescript, @types/*, tailwind, ...).
log "reconciling dependencies"
NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline

# ---- 2. build -------------------------------------------------------------
cd "$APP_DIR"
if [ "$MODE" = "dev" ]; then
  log "dev mode: skipping build (Next compiles on demand)"
elif [ "$SKIP_BUILD" = "1" ]; then
  log "SKIP_BUILD=1: reusing existing .next"
else
  log "building (incremental)"
  pnpm --filter @llm-wiki/web build
fi

# ---- 3. hand off ----------------------------------------------------------
cd "$WEB_DIR"
log "starting: $*"
exec "$@"
