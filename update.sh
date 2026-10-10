#!/usr/bin/env bash
#
# LLM Wiki - the ONLY command you need on the server.
#
#   ./update.sh llm-wiki-app.tgz
#
# Works for the very first deploy AND for every update afterwards:
#   1. back up the current ./app      -> app.bak.<timestamp>
#   2. unpack the archive over ./app
#   3. carry .env.local forward from the backup (secrets are never packed)
#   4. start / recreate the container
#
# node_modules and .next live in Docker named volumes, so none of this forces a
# dependency reinstall: install is a no-op unless the lockfile changed, and the
# build reuses its cache.

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

echo "==> [2/4] unpacking $(basename "$ARCHIVE") into ./app"
mkdir -p app
tar -xzf "$ARCHIVE" -C app --strip-components=1
mkdir -p data/wikis data/config

# Secrets are deliberately excluded from the release archive, so carry them
# forward from the backup instead of re-typing them every release.
if [ -f "${BACKUP}/apps/web/.env.local" ] && [ ! -f app/apps/web/.env.local ]; then
  echo "==> [3/4] restoring .env.local from backup"
  cp "${BACKUP}/apps/web/.env.local" app/apps/web/.env.local
else
  echo "==> [3/4] .env.local already present or nothing to restore"
fi
if [ ! -f app/apps/web/.env.local ]; then
  echo "    WARNING: no .env.local - LLM calls will fail. Create it at:"
  echo "    $ROOT/app/apps/web/.env.local"
fi

# `up -d --force-recreate`, not `restart`, on purpose: step [1/4] replaced ./app
# with a NEW directory (mv + mkdir), so the old bind-mount source and the new
# tree are different inodes. On some Docker versions `restart` reuses the
# existing mount namespace and keeps serving the code that now sits in
# app.bak.<stamp> - i.e. the update would silently do nothing.
if docker compose ps -q wiki 2>/dev/null | grep -q .; then
  echo "==> [4/4] recreating container with the new code"
  docker compose up -d --force-recreate wiki
else
  echo "==> [4/4] first deploy - building the image, then starting"
  docker compose up -d --build
fi

echo
echo "Done. Follow the startup log with:"
echo "    cd $ROOT && docker compose logs -f wiki"
echo
echo "Once it prints 'starting: node ... next start', open:"
echo "    http://<server-ip>:3737"
echo
if [ -d "$BACKUP" ]; then
  echo "If something is broken, roll back to the previous version with:"
  echo "    cd $ROOT && rm -rf app && mv $BACKUP app && docker compose up -d --force-recreate wiki"
  echo
fi
