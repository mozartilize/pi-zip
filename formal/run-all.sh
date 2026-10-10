#!/bin/sh
# the acceptance run: every target (see README "How to run"); per-trace verdicts next to each report (out/*.v)
mkdir -p out
rm -f out/ALL-DONE
B=./target/release/pz-formal
A="--suite standard --random 3000 --seed 1 --workers 26 --shrink 40"
LA='{"lookahead":true}'
run() { n=$1; shift; $B check "$@" $A --json out/$n.json --verdicts out/$n.v > out/$n.txt 2> out/$n.err; }
run v028 --src /tmp/pz-replay/src
run affine --src ../src
run coldwarm --src /tmp/pz-coldwarm/src
run coldwarm-lookahead --src /tmp/pz-coldwarm/src --plan-opts "$LA"
if [ -d /tmp/pz-rc/src ]; then
  run rc030 --src /tmp/pz-rc/src
  run rc030-lookahead --src /tmp/pz-rc/src --plan-opts "$LA"
fi
echo done > out/ALL-DONE
