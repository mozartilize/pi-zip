#!/bin/sh
# the acceptance run: every target (see README "How to run")
mkdir -p out
B=./target/release/pz-formal
A="--suite standard --random 3000 --seed 1 --workers 24 --shrink 40"
LA='{"lookahead":true}'
$B check --src /tmp/pz-replay/src $A --json out/v028.json > out/v028.txt 2> out/v028.err
$B check --src ../src $A --json out/affine.json > out/affine.txt 2> out/affine.err
$B check --src /tmp/pz-coldwarm/src $A --json out/coldwarm.json > out/coldwarm.txt 2> out/coldwarm.err
$B check --src /tmp/pz-coldwarm/src $A --plan-opts "$LA" --json out/coldwarm-lookahead.json > out/coldwarm-lookahead.txt 2> out/coldwarm-lookahead.err
$B check --src /tmp/pz-rc/src $A --json out/rc030.json > out/rc030.txt 2> out/rc030.err
$B check --src /tmp/pz-rc/src $A --plan-opts "$LA" --json out/rc030-lookahead.json > out/rc030-lookahead.txt 2> out/rc030-lookahead.err
echo done > out/ALL-DONE
