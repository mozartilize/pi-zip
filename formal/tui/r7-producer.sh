#!/usr/bin/env bash
# Real Pi TUI producer regression with a local fake provider; no network or model API.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$ROOT/formal/out"
R=$(mktemp -d "$ROOT/formal/out/tui-producer-XXXXXX")
mkdir -p "$R/agent" "$R/work"
export PI_CODING_AGENT_DIR="$R/agent" FAKE_LOG="$R/requests.jsonl"
export PI_ZIP_LEDGER="$R/ledger.jsonl" PI_ZIP_CACHE_STATS="$R/stats.json"
export XDG_CACHE_HOME="$R/cache" FAKE_EXPLICIT=1 FAKE_SUMMARY_DELAY_MS=500 PI_ZIP_TTL_SECS=2
printf '%s\n' '{"compaction":{"enabled":false},"defaultProvider":"fake","defaultModel":"m","lastChangelogVersion":"1.1.0","quietStartup":true}' > "$R/agent/settings.json"
P=(pi --no-extensions -e "$ROOT/formal/tui/fakeprov.ts" -e "$ROOT/src/index.ts" --provider fake --model m)
cd "$R/work"
PI_ZIP_OFF=1 timeout 30 "${P[@]}" -p 'Inspect. [[bash:head -n 150 /etc/services]]' > "$R/history.log" 2>&1
for i in $(seq 1 12); do PI_ZIP_OFF=1 timeout 30 "${P[@]}" -c -p "Step $i. [[bash:echo ok]]" >> "$R/history.log" 2>&1; done
python3 -c 'print(" ".join("word" + str(i) for i in range(26000)))' > "$R/notes.txt"
PI_ZIP_OFF=1 timeout 30 "${P[@]}" -c -p "@$R/notes.txt" 'Keep the notes.' >> "$R/history.log" 2>&1
SESSION=$(find "$R/agent/sessions" -name '*.jsonl' | head -1)
python3 - "$SESSION" <<'PY'
import json,sys,time
p=sys.argv[1]
rows=[json.loads(x) for x in open(p)]
from datetime import datetime, timezone
shift=int(time.time()*1000)-7200000-max(r.get('message',{}).get('timestamp',0) for r in rows)
for r in rows:
    m=r.get('message',{})
    if isinstance(m.get('timestamp'),(int,float)): m['timestamp']+=shift
    if r.get('type') != 'session' and r.get('timestamp'):
        t=datetime.fromisoformat(r['timestamp'].replace('Z','+00:00'))
        r['timestamp']=datetime.fromtimestamp(t.timestamp()+shift/1000,timezone.utc).isoformat()
open(p,'w').write(''.join(json.dumps(r)+'\n' for r in rows))
PY
S="pz-producer-$$"
trap 'tmux kill-session -t "$S" 2>/dev/null || true' EXIT
# Quote paths before sending shell text through tmux.
printf -v CMD '%q ' env "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR" "FAKE_LOG=$FAKE_LOG" "PI_ZIP_LEDGER=$PI_ZIP_LEDGER" "PI_ZIP_CACHE_STATS=$PI_ZIP_CACHE_STATS" "XDG_CACHE_HOME=$XDG_CACHE_HOME" "FAKE_EXPLICIT=1" "FAKE_SUMMARY_DELAY_MS=500" "PI_ZIP_TTL_SECS=2" "${P[@]}" -c
tmux new-session -d -s "$S" -x 120 -y 50 "$CMD"
sleep 3
tmux send-keys -t "$S" -l 'Continue with a short answer.'
sleep 3
python3 - "$PI_ZIP_LEDGER" <<'PY'
import json,sys
rows=[json.loads(x) for x in open(sys.argv[1])]
assert not any(r['type']=='away_summary_start' for r in rows), 'opening or typing started a summary'
print('Old history and typing stay quiet.')
PY
tmux send-keys -t "$S" Enter
sleep 5
tmux capture-pane -t "$S" -p > "$R/idle.txt"
python3 - "$PI_ZIP_LEDGER" "$SESSION" <<'PY'
import json,sys
rows=[json.loads(x) for x in open(sys.argv[1])]
assert any(r['type']=='want' and r.get('at') in ('settle','timer') for r in rows), 'idle producer was not judged'
assert any(r['type']=='away_summary_start' for r in rows), 'no background summary'
assert not any(r['type']=='room_wait' for r in rows), 'unexpected wait below room'
entries=[json.loads(x) for x in open(sys.argv[2])]
assert any(r.get('customType')=='pi-zip/summary' and r.get('data',{}).get('cut') for r in entries), 'finished summary was not persisted'
print('Idle production runs in the background and persists its result.')
PY
tmux send-keys -t "$S" -l '/quit'
tmux send-keys -t "$S" Enter
