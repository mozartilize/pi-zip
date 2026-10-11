#!/usr/bin/env bash
# Round 5 TUI check: the 08:14 incident on Pi 1.1.0 in tmux with the fake provider (no model calls), the summary call taking 40 s.
# usage: run.sh <src dir> <tag> <live|restart>
#   history (pi-zip off, print mode): A with a tool output, 12 small tool steps, B with ~270K chars of notes (~110K tokens in all, as the
#   incident's 111.5K)
#   TUI, pi-zip on, TTL 300 s: "C ..." (B protected: nothing to summarise), the run ends; settle runs.
#   live:    108 s later (warm) "D: answer briefly"
#   restart: 75 s after C, /quit and `pi -c` again; first key of D at 100 s, Enter at 108 s; D runs a 50 s tool (the run goes on)
set -u
R=${PZ_TUI_DIR:-/tmp/pz-r5-tui}; mkdir -p $R; cp -n "$(dirname "$0")/fakeprov.ts" $R/
SRC=$1; tag=$2; mode=$3
A=$R/agent-$tag; W=$R/work-$tag; S=pzr5-$tag
export PI_CODING_AGENT_DIR=$A FAKE_LOG=$R/$tag-fake.log
L=$R/$tag-ledger.jsonl; ST=$R/$tag-stats.json; OUT=$R/$tag.out
rm -rf $A $W $FAKE_LOG $L $ST $OUT && mkdir -p $A $W && cd $W
echo '{"compaction":{"enabled":false},"defaultProvider":"fake","defaultModel":"m","lastChangelogVersion":"1.1.0","quietStartup":true}' > $A/settings.json
P="pi --no-extensions -e $R/fakeprov.ts -e $SRC/index.ts --provider fake --model m"
ENV="env PI_CODING_AGENT_DIR=$A FAKE_LOG=$FAKE_LOG FAKE_EXPLICIT=1 FAKE_SUMMARY_DELAY_MS=40000 PI_ZIP_LEDGER=$L PI_ZIP_CACHE_STATS=$ST PI_ZIP_TTL_SECS=300 XDG_CACHE_HOME=$R/xdg-$tag"
python3 -c 'print(" ".join(f"word{i}" for i in range(26000)))' > $R/big-$tag.txt # ~270K chars of prose: only a summary can shrink it
PI_ZIP_OFF=1 FAKE_EXPLICIT=1 timeout 60 $P -p "A: look at services [[bash:head -n 150 /etc/services]]" >/dev/null 2>&1
for i in $(seq 1 12); do PI_ZIP_OFF=1 FAKE_EXPLICIT=1 timeout 60 $P -c -p "s$i: step $i [[bash:echo step-$i]]" >/dev/null 2>&1; done # small steps: the growth per request g stays small
PI_ZIP_OFF=1 FAKE_EXPLICIT=1 timeout 60 $P -c -p @$R/big-$tag.txt "B: keep these notes in mind" >/dev/null 2>&1
cap() { echo "=== $1"; tmux capture-pane -t $S -p | grep -v '^\s*$' | tail -${2:-16}; } >> $OUT
tmux kill-session -t $S 2>/dev/null
tmux new-session -d -s $S -x 120 -y 50 "bash --norc"
tmux send-keys -t $S "cd $W && $ENV $P -c" Enter
sleep 5
tmux send-keys -t $S "C: check the protocols [[bash:head -n 40 /etc/protocols]]" Enter
T0=$(date +%s.%N)
sleep 3
cap "C done"
at() { python3 -c "import time,sys; t0=float(sys.argv[1]); d=float(sys.argv[2])-(time.time()-t0); time.sleep(max(0,d))" $T0 $1; }
if [ "$mode" = restart ]; then
  at 75
  tmux send-keys -t $S "/quit" Enter
  sleep 2
  tmux send-keys -t $S "$ENV $P -c" Enter
  at 100
  tmux send-keys -t $S "D: run the slow check [[bash:sleep 50; echo slow-check-done]]"
  at 108
  tmux send-keys -t $S Enter
else
  at 108
  tmux send-keys -t $S "D: answer briefly" Enter
fi
TD=$(date +%s.%N)
for s in 2 10 30 45; do python3 -c "import time,sys; t0=float(sys.argv[1]); time.sleep(max(0,float(sys.argv[2])-(time.time()-t0)))" $TD $s; cap "$s s after D's Enter"; done
if [ "$mode" = restart ]; then python3 -c "import time,sys; t0=float(sys.argv[1]); time.sleep(max(0,float(sys.argv[2])-(time.time()-t0)))" $TD 100; cap "100 s after D's Enter" 30; fi
tmux kill-session -t $S
F=$(ls -t $A/sessions/*/*.jsonl | head -1)
echo "=== session tail (from C on)" >> $OUT
node -e '
const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const i0=L.findIndex(e=>e.type==="message"&&e.message.role==="user"&&JSON.stringify(e.message.content).includes("C: check"));
for (const e of L.slice(i0)) {
  const t=(e.timestamp||"").slice(11,19);
  if (e.type==="compaction") console.log(t, `compaction(tokensBefore=${e.tokensBefore}, fromHook=${e.fromHook}, details=${JSON.stringify(e.details)})`);
  else if (e.type==="context_edit") console.log(t, `context_edit(${e.targetId})`);
  else if (e.type==="message") console.log(t, `${e.message.role}${e.message.role==="user"?"("+JSON.stringify(e.message.content).slice(10,22)+")":""}${e.message.usage?" usage="+e.message.usage.totalTokens:""}`);
  else if (e.type==="custom" && e.customType==="pi-zip/notice") console.log(t, `notice(${e.data.kind ?? "plan"}: before=${e.data.before} after=${e.data.after} ${e.data.desc}${e.data.native?" native="+e.data.native:""})`);
  else console.log(t, e.type + (e.customType ? "("+e.customType+")" : ""));
}' "$F" >> $OUT
echo "=== requests" >> $OUT
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const j=JSON.parse(l); console.log(j.pid%1000, j.i, j.n+" msgs", "total="+j.total, j.summarizer?"(summary call)":"", j.summary?"CARRIES SUMMARY":""); }' $FAKE_LOG >> $OUT
echo "=== ledger" >> $OUT
grep -h '"type":"native\|"type":"summary"\|"type":"cold_plan"\|"type":"settle_plan"\|"type":"away_summary\|"type":"prompt"\|"type":"warm_\|"type":"key_\|"type":"pin"\|"type":"unused' $L | cut -c1-300 >> $OUT
echo DONE >> $OUT
