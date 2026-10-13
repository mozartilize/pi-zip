#!/usr/bin/env bash
# Real Pi TUI with isolated history and a local provider; zero network or LLM API spend.
# PI_BIN selects the Pi binary (default "pi"); for Pi 1.1.0 put a wrapper named pi first on PATH, or point PI_BIN at it.
set -euo pipefail
PI_BIN=${PI_BIN:-pi}
PI_VERSION=$("$PI_BIN" --version | tail -1)
echo "Pi $PI_VERSION ($(command -v "$PI_BIN"))"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${DOORS_OUT:-$ROOT/formal/out} # where the sessions, ledgers and screens go
mkdir -p "$OUT"
R=$(mktemp -d "$OUT/tui-doors-XXXXXX")
S="pz-doors-$$"
trap 'tmux kill-session -t "$S" 2>/dev/null || true' EXIT
for path in typed driven midrun; do
  D="$R/$path"
  mkdir -p "$D/agent" "$D/work"
  export PI_CODING_AGENT_DIR="$D/agent" PI_ZIP_CACHE_STATS="$D/stats.json" XDG_CACHE_HOME="$D/cache"
  export FAKE_LOG="$D/requests.jsonl" PI_ZIP_LEDGER="$D/ledger.jsonl" DOOR_LOG="$D/doors.jsonl"
  export FAKE_EXPLICIT=1 FAKE_SUMMARY_DELAY_MS=50 PI_ZIP_TTL_SECS=300
  printf '{"compaction":{"enabled":false},"lastChangelogVersion":"%s","quietStartup":true}\n' "$PI_VERSION" > "$D/agent/settings.json"
  ready=ready
  if [[ "$path" == midrun ]]; then ready=unready; fi
  (cd "$D/work" && bun "$ROOT/formal/tui/r7-doors.ts" fixture "$D/session.jsonl" "$ready")
  P=("$PI_BIN" --no-extensions -e "$ROOT/formal/tui/fakeprov.ts" -e "$ROOT/src/index.ts" -e "$ROOT/formal/tui/r7-doors.ts" --provider fake --model m --session "$D/session.jsonl")
  printf -v CMD '%q ' env "PATH=$PATH" "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR" "PI_ZIP_CACHE_STATS=$PI_ZIP_CACHE_STATS" "XDG_CACHE_HOME=$XDG_CACHE_HOME" "FAKE_LOG=$FAKE_LOG" "PI_ZIP_LEDGER=$PI_ZIP_LEDGER" "DOOR_LOG=$DOOR_LOG" "FAKE_EXPLICIT=1" "FAKE_SUMMARY_DELAY_MS=50" "PI_ZIP_TTL_SECS=300" "${P[@]}"
  (cd "$D/work" && tmux new-session -d -s "$S" -x 150 -y 55 'bash --noprofile --norc')
  tmux send-keys -t "$S" -l "$CMD"
  tmux send-keys -t "$S" Enter
  sleep 2
  case "$path" in
    typed) text='Continue with a short answer.' ;;
    driven) text='/drive' ;;
    midrun) text='Continue. [[bash:sleep 1]]' ;;
  esac
  tmux send-keys -t "$S" -l "$text"
  tmux send-keys -t "$S" Enter
  sleep 4
  tmux capture-pane -t "$S" -p -S -2000 > "$D/tui.txt"
  tmux send-keys -t "$S" -l '/quit'
  tmux send-keys -t "$S" Enter
  sleep 1
  tmux kill-session -t "$S" 2>/dev/null || true
  python3 - "$D" "$path" <<'PY'
import json,sys,re
from pathlib import Path
p=Path(sys.argv[1]); door=sys.argv[2]
entries=[json.loads(x) for x in (p/'session.jsonl').read_text().splitlines()]
comps=[e for e in entries if e.get('type')=='compaction' and e.get('details',{}).get('by')=='pi-zip']
assert comps, f'{door}: no compaction'
rows=[json.loads(x) for x in (p/'ledger.jsonl').read_text().splitlines()]
summary=next(e for e in rows if e.get('type')=='summary')
comp=comps[0]
assert comp['tokensBefore']==summary['tokensBefore'], f'{door}: number differs from before'
if door=='typed': assert comp['details'].get('via')=='native'
else:
    assert comp['details'].get('via')!='native'
    drafts=[json.loads(x)['drafts'] for x in (p/'doors.jsonl').read_text().splitlines()]
    assert any(d and d[0]=='compaction' for d in drafts), f'{door}: compaction not first'
    assert comp['details']['carried'] is False
pane=(p/'tui.txt').read_text()
number=f"{comp['tokensBefore']:,}"
assert re.search(r'Compacted from\s+'+re.escape(number),pane), f'{door}: TUI lacks exact number {number}'
print(f'{door}: Compacted from equals pi-zip before ({number}).')
PY
done
