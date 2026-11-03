#!/bin/bash
# Render: the web app and the queue worker in one service, so both see the same job files on the
# service's persistent disk (a Render disk attaches to one service only). If either process stops,
# the container exits and Render restarts it.
set -euo pipefail

# The disk mounts root-owned; hand it to the node user, then drop root.
mkdir -p "$WM_DATA_DIR"
chown node:node "$WM_DATA_DIR"
run() { setpriv --reuid=node --regid=node --init-groups "$@"; }

run node --import tsx apps/worker/src/worker.ts &
worker=$!
(cd apps/web/.next/standalone && PORT="${PORT:-3100}" HOSTNAME=0.0.0.0 run node apps/web/server.js) &
web=$!

trap 'kill -TERM $worker $web 2>/dev/null; wait' TERM INT
wait -n $worker $web
echo "A process exited; stopping the service so Render restarts it" >&2
kill -TERM $worker $web 2>/dev/null || true
wait
exit 1
