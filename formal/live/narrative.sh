#!/bin/bash
# Live release check (real model, costs real tokens): this tree's narrative call on a real session must come back ok.
# usage: formal/live/narrative.sh <session.jsonl> [provider/model] [fractions, default 0.3,0.9]
# A long session with CJK text and an earlier pi-zip compaction is the case 0.4.0/0.4.1 failed on (every call hit the cap).
set -u
here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/../../src" && pwd)
out=$(mktemp /tmp/pz-live.XXXXXX)
PZL_SRC="$src" PZL_SESSION="$1" PZL_FRACS="${3:-0.3,0.9}" PZL_OUT="$out" \
	timeout 900 "${PI_BIN:-pi}" -p "/pzlive" --no-session --no-extensions -e "$here/narrative-probe.ts" --model "${2:-sota/claude-opus-5-5}" >/dev/null 2>&1
cat "$out"
grep -q "^LIVE PASS$" "$out"
