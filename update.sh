#!/usr/bin/env bash
#
# LLM Wiki - server-side update script.
#
# Usage:  ./update.sh /path/to/llm-wiki-app.tgz
#
# Does:   backup current ./app -> unpack archive over it -> restart container
#         -> tail logs. The previous tree is kept in app.bak.<timestamp> so a
#         bad release is one `mv` away from being undone.
#
# The pnpm store and node_modules live in Docker named volumes, so replacing
# ./app never forces a full dependency reinstall: the entrypoint's
# `pnpm install` is a no-op when the lockfile is unchanged.

set -euo pipefail

ROOT="${ROOT:-/srv/llm-wiki}"
ARCHIVE="${1:-}"

if [ -z "$ARCHIVE" ]; then
  echo "usage: $0 <archive.tgz>" >&2
  exit 2
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "error: archive not found: $ARCHIVE" >&2
  exit 2
fi

if [ ! -f "$ROOT/docker-compose.yml" ]; then
  echo "error: docker-compose.yml not found in $ROOT" >&2
  exit 2
fi

cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="app.bak.${STAMP}"

echo "==> [1/4] backing up ./app -> ./${BACKUP}"
if [ -d app ]; then
  mv app "$BACKUP"
else
  echo "    (no existing ./app - first deploy)"
fi

echo "==> [2/4] unpacking $(basename "$ARCHIVE")"
mkdir -p app
tar -xzf "$ARCHIVE" -C app --strip-components=1

# Secrets are deliberately excluded from the release archive so they never
# ride along in a tarball. Carry them forward from the backup instead.
if [ -f "${BACKUP}/apps/web/.env.local" ] && [ ! -f app/apps/web/.env.local ]; then
  echo "==> [3/4] restoring .env.local from backup"
  cp "${BACKUP}/apps/web/.env.local" app/apps/web/.env.local
else
  echo "==> [3/4] .env.local already present or nothing to restore"
fi

# --force-recreate, not `restart`, on purpose:
#   step [1/4] replaced ./app with a NEW directory (mv + mkdir), so the old
#   bind-mount source and the new tree are different inodes. A plain `restart`
#   reuses the existing container's mount namespace on some Docker versions and
#   would keep serving the code now sitting in app.bak.<stamp> — i.e. the update
#   would appear to do nothing. Recreating resolves the bind source again.
#   This does NOT rebuild the image (no --build), so named volumes survive and
#   the entrypoint's install/build stay incremental.
echo "==> [4/4] recreating container"
docker compose up -d --force-recreate wiki

echo
echo "Restarting. Tail the logs with:"
echo "    cd $ROOT && docker compose logs -f wiki"
echo
echo "If the new release is broken, roll back with:"
echo "    cd $ROOT && rm -rf app && mv $BACKUP app && docker compose up -d --force-recreate wiki"
