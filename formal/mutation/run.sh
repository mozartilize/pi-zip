#!/bin/bash
# the mutation run with the revised checker: base twice (determinism), every mutant; standard suite + 3000 random (seed 1), no shrinking
cd "$(dirname "$0")/.."
O=${MUT_OUT:-/tmp/pz-review-mut/v2}
mkdir -p $O
for d in base base2 /tmp/pz-review-mut/m*/; do
  n=$(basename $d); src=/tmp/pz-review-mut/$n/src; [ $n = base2 ] && src=/tmp/pz-review-mut/base/src
  [ -d "$src" ] || continue
  [ -f $O/$n.json ] && continue
  ./target/release/pz-formal check --src $src --suite standard --random 3000 --seed 1 --workers 26 --shrink 0 --json $O/$n.json --verdicts $O/$n.v > $O/$n.txt 2> $O/$n.err
  echo "$n done $(date +%T)" >> $O/progress.log
done
echo ALLDONE >> $O/progress.log
