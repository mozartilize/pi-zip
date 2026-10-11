#!/usr/bin/env bash
# Machine-check gate for the pi-zip proofs.
#
#   ./check.sh          full gate: frozen statements, forbidden constructs, build, audit, kernel re-check
#   ./check.sh --quick  same without the leanchecker re-check
#
# A statement is a `def <Name> : Prop` (Name = T<k>_<part>) in PiZip/Statements/*.lean, inside `namespace PiZip`.
# Its proof is `theorem <Name>_proof : PiZip.<Name>`; a refutation is `theorem <Name>_false : ¬ PiZip.<Name>`.
# Optional non-vacuity witness: `theorem <Name>_nonvacuous : ...` (the hypotheses can be met).
# PROVED / REFUTED means: the audit file type-checks `theorem audit_<Name>_proof : PiZip.<Name> := PiZip.<Name>_proof` against the frozen
# definition, and `#print axioms` lists nothing beyond propext, Classical.choice and Quot.sound.
set -uo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.elan/bin:$PATH"
QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1
fail=0
note() { echo "FAIL: $*"; fail=1; }

echo "== 1. frozen files"
if [ -s FROZEN.sha256 ]; then
  sha256sum --quiet -c FROZEN.sha256 || note "a frozen file changed (FROZEN.sha256)"
else
  echo "(nothing frozen yet)"
fi

echo "== 2. forbidden constructs"
FORBID='skipKernelTC|addDeclWithoutChecking|\bunsafe\b|\brun_cmd\b|\brun_elab\b|\brun_meta\b|\belab_rules\b|^\s*(elab|macro|macro_rules|syntax|initialize|builtin_initialize)\b|^\s*(private\s+|protected\s+)?axiom\b|@\[extern|implemented_by|native_decide|ofReduceBool|Lean\.Elab|Lean\.Meta|\bopaque\b|\bsorry\b|\badmit\b|debug\.'
if grep -rnE "$FORBID" PiZip PiZip.lean --include=*.lean; then note "forbidden construct (lines above)"; fi
if grep -rnP '[\x{3000}-\x{303F}\x{3400}-\x{9FFF}\x{F900}-\x{FAFF}\x{FF00}-\x{FFEF}]' PiZip PiZip.lean --include=*.lean; then
  note "CJK characters (lines above)"
fi

echo "== 3. every module is imported by PiZip.lean"
mods=$(find PiZip -name '*.lean' | sed 's/\.lean$//; s#/#.#g' | sort)
for m in $mods; do
  grep -qE "^import $m\s*$" PiZip.lean || note "module $m is not imported by PiZip.lean, so lake build would not check it"
done

echo "== 4. lake build"
if lake build > audit/build.log 2>&1; then
  grep -E "^error|declaration uses 'sorry'" audit/build.log && note "build log has errors or sorry"
  tail -1 audit/build.log
else
  grep -E "error" audit/build.log | head -40
  note "lake build failed (audit/build.log)"
fi

echo "== 5. audit: proofs against the frozen statements"
names=$(grep -hoE '^def[[:space:]]+T[0-9]+_[A-Za-z0-9_]+[[:space:]]*:[[:space:]]*Prop\b' PiZip/Statements/*.lean 2>/dev/null \
        | awk '{print $2}' | sort -u)
A=audit/Audit.lean
echo "import PiZip" > $A
for n in $names; do
  if grep -rqE "^[[:space:]]*theorem[[:space:]]+${n}_proof\b" PiZip; then
    printf 'theorem audit_%s_proof : PiZip.%s := PiZip.%s_proof\n#print axioms audit_%s_proof\n' "$n" "$n" "$n" "$n" >> $A
  fi
  if grep -rqE "^[[:space:]]*theorem[[:space:]]+${n}_false\b" PiZip; then
    printf 'theorem audit_%s_false : ¬ PiZip.%s := PiZip.%s_false\n#print axioms audit_%s_false\n' "$n" "$n" "$n" "$n" >> $A
  fi
done
lake env lean $A > audit/audit.out 2>&1
grep -E "error" audit/audit.out | head -20 && note "audit file has errors (a proof's type is not exactly its frozen statement, or it is in the wrong namespace)"
ok_axioms() { # $1 = the "depends on axioms" line
  local list; list=$(echo "$1" | sed -n "s/.*depends on axioms: \[\(.*\)\]/\1/p" | tr -d ' ')
  [ -z "$list" ] && { echo "$1" | grep -q "does not depend on any axioms"; return; }
  local a; for a in ${list//,/ }; do case "$a" in propext|Classical.choice|Quot.sound) ;; *) return 1;; esac; done
}
proved=0; refuted=0; missing=0; total=0
printf '%-28s %-9s %-11s %s\n' STATEMENT STATUS WITNESS AXIOMS
for n in $names; do
  total=$((total+1)); st=MISSING; ax="-"
  for kind in proof false; do
    declared=0; grep -rqE "^[[:space:]]*theorem[[:space:]]+${n}_${kind}\b" PiZip && declared=1
    line=$(grep -E "'audit_${n}_${kind}' (depends on axioms|does not depend)" audit/audit.out | head -1)
    if [ -z "$line" ]; then
      [ $declared = 1 ] && { st=MISMATCH; note "${n}_${kind} does not have exactly the type of the frozen statement"; }
      continue
    fi
    ax=$(echo "$line" | sed -E "s/.*(depends on axioms: |does not depend on any axioms)/\1/")
    if ok_axioms "$line"; then
      [ $kind = proof ] && st=PROVED || st=REFUTED
    else
      st=BAD-AXIOMS; note "$n uses a non-standard axiom: $ax"
    fi
  done
  wit=no; grep -rqE "^[[:space:]]*theorem[[:space:]]+${n}_nonvacuous\b" PiZip && wit=yes
  case $st in PROVED) proved=$((proved+1));; REFUTED) refuted=$((refuted+1));; MISSING) missing=$((missing+1));; esac
  printf '%-28s %-9s %-11s %s\n' "$n" "$st" "$wit" "$ax"
done

if [ $QUICK = 0 ]; then
  echo "== 6. kernel re-check (leanchecker) of every PiZip module"
  for m in PiZip $mods; do
    if ! out=$(timeout 1800 lake env leanchecker "$m" 2>&1); then echo "$out" | tail -5; note "leanchecker rejected $m"; fi
  done
  [ $fail = 0 ] && echo "leanchecker: all modules re-checked"
fi

echo "CHECK: statements $total, proved $proved, refuted $refuted, missing $missing, gate $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
