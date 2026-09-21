#!/bin/sh
# A gateway that has never been used, without touching one that has.
#
# Every piece of state goes to a throwaway directory and the port is not 8080,
# so this runs beside a real installation — the desktop app, or another
# checkout — and neither sees the other. Weights are only read, from wherever
# they already are, so nothing is downloaded.
#
#   sh scripts/dev-fresh.sh            a team install with nobody in it, real judge
#   FRESH_MODE=mock sh scripts/dev-fresh.sh     no weights at all (the run must be opened by URL)
#   FRESH_HOST=127.0.0.1 sh scripts/dev-fresh.sh   bound to loopback, to see step 2
#   FRESH_KEEP=1 sh scripts/dev-fresh.sh           keep the state from the last run
#   FRESH_MODELS=~/Library/Application\ Support/Warden/models sh scripts/dev-fresh.sh   weights from the desktop app
#
# Stop it with Ctrl-C. The state is under $TMPDIR/warden-fresh and is wiped on
# the next start unless FRESH_KEEP is set.
set -e
cd "$(dirname "$0")/.."

PORT="${FRESH_PORT:-8138}"
DATA="${TMPDIR:-/tmp}/warden-fresh"
[ -n "$FRESH_KEEP" ] || rm -rf "$DATA"
mkdir -p "$DATA"

# The first models directory that has weights in it: this checkout's, or the
# one two levels up when this is a git worktree under .claude/worktrees/.
#
# FRESH_MODELS names one outright. The search stops at the first directory with
# any weights in it, which is not the same as the weights the default judge
# wants: a checkout set up before DynaGuard-4B became the default has the
# Qwen3 files and nothing else, the preload fails, and the run reaches step 4
# with no judge to answer it. The desktop app's directory usually has them all.
MODELS=""
for dir in "$FRESH_MODELS" "$PWD/models" "$PWD/../../../models"; do
  [ -n "$dir" ] || continue
  if ls "$dir"/*.gguf >/dev/null 2>&1; then MODELS="$(cd "$dir" && pwd)"; break; fi
done

export WARDEN_PORT="$PORT"
export WARDEN_HOST="${FRESH_HOST:-0.0.0.0}"
# What the desktop splash would have written for "The team console". Without
# it an empty directory reads as a solo install and the nav has no Team item.
export WARDEN_INSTALL_INTENT="${FRESH_INTENT:-team}"
export WARDEN_ADAPTER="${FRESH_MODE:-real}"
if [ "$WARDEN_ADAPTER" = real ] && [ -z "$MODELS" ]; then
  echo "No weights found; starting in demo mode. Open #/teamSetup by hand." >&2
  export WARDEN_ADAPTER=mock
fi
export WARDEN_MODELS_DIR="${MODELS:-$DATA/models}"
for f in AUDIT POLICY COMPANY SETTINGS PROMPT PROMPT_TEMPLATES APPEALS ESCALATIONS RATE_STATE MODEL_CATALOG DEVICES VERIFIED; do
  export "WARDEN_${f}_PATH=$DATA/$(echo "$f" | tr 'A-Z' 'a-z').json"
done

echo "Fresh Warden on http://localhost:$PORT  (state in $DATA, adapter=$WARDEN_ADAPTER, bound to $WARDEN_HOST)"
exec node --import tsx src/server/index.ts
