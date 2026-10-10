#!/usr/bin/env python3
"""Mutation score of the revised checker. A mutant is caught by a property that names the bug when that property goes from 0 to
failing, gains a counterexample class, or (the per-trace verdicts) fails on a trace where it passed on base. Side effect: some other
property changes. Survived: nothing changes."""
import json, os, sys

V = os.environ.get("MUT_OUT", "/tmp/pz-review-mut/v2")
NAMES = {  # the properties that describe each injected bug
    "m01_recall_tool_truncates": ["A1"], "m02_placeholder_no_handle": ["A1"], "m03_summary_drops_users": ["A1"], "m04_view_drops_prose": ["A1"],
    "m05_warm_gate_ignored": ["A2", "A2r"], "m06_prices_cheap_write": ["LW"], "m07_no_away_timer": ["A3"], "m08_away_after_ttl": ["A3"],
    "m09_persist_differs": ["I1"], "m10_b2b_off": ["B2B"], "m11_refold_recalled": ["RC"], "m12_fold_recall_results": ["RC"],
    "m13_warm_relax": ["PW"], "m14_protect_one_turn": ["PW"], "m15_no_summarized_warm": ["NT"], "m16_no_summary_floor": [],
    "m17_cap_60k": ["TR"], "m18_cold_by_4ttl": ["GC"], "m18b_cold_needs_long_gap": ["GC"], "m19_switch_not_cold": ["GC"],
    "m20_no_min_expect_head": ["MH"], "m21_long_tier_ignored": ["LW"], "m22_steer_as_turns": ["PW"], "m23_recalled_forgotten_on_restart": ["RC"],
    "m24_resummarise_prev_summary": [], "m25_summary_call_free": ["A2", "A2r", "LW"], "m26_warm_below_cap": ["WB"], "m27_cold_ignores_branch_clock": ["RD", "RDr", "GC"],
    "m28_relax_warm_only": ["PW", "MP", "MPr"],
}


def load(n):
    j = json.load(open(f"{V}/{n}.json"))
    counts = {p["id"]: p["violations"] for p in j["props"]}
    classes = {p["id"]: {c["class"] for c in p["counterexamples"]} for p in j["props"]}
    verd = []
    for line in open(f"{V}/{n}.v"):
        x = json.loads(line)
        verd.append({k: v.rsplit(" @", 1)[0] for k, v in x.get("fails", {}).items()})
    return counts, classes, verd, j.get("bridgeErrors", 0)


bc, bcl, bv, be = load("base")
if os.path.exists(f"{V}/base2.json"):
    c2, cl2, v2, _ = load("base2")
    print("determinism: base2 == base:", c2 == bc and cl2 == bcl and v2 == bv)
caught = side = survived = equiv = 0
named_t_only = []
rows = []
for n in sorted(NAMES):
    if not os.path.exists(f"{V}/{n}.json"):
        rows.append(f"{n}: not run")
        continue
    mc, mcl, mv, me = load(n)
    changed = {}
    for p in mc:
        newly = sum(1 for a, b in zip(bv, mv) if p in b and p not in a)
        newcls = sorted(mcl[p] - bcl.get(p, set()))
        if mc[p] != bc.get(p) or newcls or newly:
            changed[p] = (bc.get(p), mc[p], newly, newcls)
    # the review's criterion: the named property goes from 0 to failing, or gains a counterexample class
    named = [p for p in NAMES[n] if p in changed and ((changed[p][0] == 0 and changed[p][1] > 0) or changed[p][3])]
    # per-trace verdicts: the named property fails on a trace where it passed on base
    named_t = [p for p in NAMES[n] if p in changed and changed[p][2] > 0]
    if named_t and not named:
        named_t_only.append(n)
    if not NAMES[n]:
        verdict = "equivalent" if not changed else "equivalent? (changes)"
        equiv += 1
    elif named:
        verdict = "CAUGHT by " + ",".join(named)
        caught += 1
    elif changed:
        verdict = "side effect only"
        side += 1
    else:
        verdict = "SURVIVED"
        survived += 1
    detail = "; ".join(f"{p} {a}->{b} (+{k} traces{', new: ' + ' | '.join(c) if c else ''})" for p, (a, b, k, c) in sorted(changed.items()))
    rows.append(f"{n} [errors {me}]: {verdict} | {detail if detail else 'no change'}")
print("\n".join(rows))
real = caught + side + survived
print("caught only by the per-trace verdicts (a named property newly fails on some trace, counts and classes unchanged):", named_t_only)
print(f"\nreal mutants {real}: caught by a named property {caught} ({100 * caught / max(real, 1):.0f}%), side effect only {side}, survived {survived}; equivalent {equiv}")
