#!/usr/bin/env python3
"""Check the shipped Q2-free policy on the round-6 simulator; print aggregates only.

The simulator models decisions, call latency and recovery. Pi event order, persistence
and restart behavior are checked against the actual source by the integration regression.
Pass the existing tier-0 directory with --bench; no shared research files are modified.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys


def source_check(root):
    sources = sorted((root / "src").glob("*.ts"))
    text = "\n".join(p.read_text() for p in sources)
    deleted = ("summarizedWarm", "summaryRegrow", "regrowAt", "noSummary", "lastRegrow")
    assert not any(name in text for name in deleted), "source still carries Q2"
    subprocess.run(["bun", "test", "test/pi-integration.test.ts", "--test-name-pattern",
                    "restarted warm session"], cwd=root, check=True,
                   env={**os.environ, "PI_ZIP_TEST_SRC": str(root / "src")})
    print("Source policy SHA256:", hashlib.sha256(text.encode()).hexdigest(), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=("b1", "b2", "report"))
    ap.add_argument("--bench", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()
    root = Path(__file__).resolve().parents[2]
    source_check(root)
    sys.path.insert(0, str(args.bench.resolve()))
    import r6_theory_guard as G
    G.PRIV = str(args.out.resolve())
    tag = "q2free"
    # Step 7 still ships the plain application law. The guarded law belongs to step 8.
    # fx=1 supplies the existing single-call room/producer policy; os=0 drops Q2.
    if args.action != "report":
        G.run(args.action, ("anth", "glm"), {"v3g": "V3f:", "shipped": "GL:fx=1,os=0"}, args.jobs, tag)
        return
    G.cells(tag, "v3g", ("shipped",), ("b1", "b2"), 2000)
    G.headline(tag, "v3g", ("shipped",), ("b1", "b2"), 2000)
    G.traces(tag, ("b1", "b2"), "shipped")
    R = G._R()
    cells = failures = 0
    for regime in ("anth", "glm"):
        rows = R.rec_rows(tag, regime, ("b1", "b2"))
        for ttl in ("300", "3600"):
            for name, select in R.STRATA:
                p = R.paired([r for r in rows if select(r)], ttl, "shipped", "v3g", 2000 if name == "pooled" else 1000)
                assert p is not None, "missing simulator cell"
                cells += 1
                failures += p["r"][1] > 1.0 or p["d"][1] > 1e-9
    assert cells == 32 and failures == 0, f"{failures}/{cells} simulator cells fail"
    print(f"PASS: {failures}/{cells} simulator cells fail on the shipped plain-law policy.")


if __name__ == "__main__":
    main()
