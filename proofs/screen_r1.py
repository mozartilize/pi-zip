#!/usr/bin/env python3
"""Counterexample screening only. The Lean gate, not this script, is evidence."""
from fractions import Fraction as Q
from itertools import product
from math import sqrt, exp
from collections import Counter

checks = Counter()
failures = []

def check(name, result, instance=None):
    checks[name] += 1
    if not result:
        failures.append((name, instance))

def cost(B, arrivals, edits):
    pending = total = Q(0)
    for a, edit in zip(arrivals, edits):
        pending += a
        if edit:
            total += B
            pending = Q(0)
        else:
            total += pending
    return total

def execute(B, arrivals, mode, alpha=Q(1), estimate=lambda history: Q(1), pred=None):
    pending = rent = total = Q(0)
    edits = []
    history = []
    for a in arrivals:
        history.append(a)
        pending += a
        rent += pending
        law = pending ** 2 >= 2 * estimate(history) * B
        pi = law if pred is None else pred(history, pending, rent)
        edit = (pending > 0 and rent >= B) if mode == 'bal' else law
        if mode == 'guard':
            edit = pending > 0 and (rent >= B or (pi and rent >= alpha * B))
        edits.append(edit)
        if edit:
            total += B
            pending = rent = Q(0)
        else:
            total += pending
    return total, edits

def rate(B, g, L):
    return B / L + g * (L - 1) / 2

def delta(A, D, n, k, c, eta, p, V):
    return p*k*(A-n)-(1-p)*k*D-eta*D+c-V

# All model-C formulas and legal boundary cases, exact rational arithmetic.
for A, D, k, c, eta, n, p, F, g in product(
        map(Q, (1, 2)), map(Q, (1, 2)), map(Q, (1, 4)), map(Q, (0, 1)),
        map(Q, (0, 1)), map(Q, (0, 1)), map(Q, (0, Q(1,2), 1)),
        map(Q, (0, 1)), map(Q, (1, 2))):
    B = A + D
    fire = (1+k)*A+c
    hold = p*(B+k*n)+(1-p)*(1+k)*B+eta*D+F
    V = D+F
    check('T2_i', fire-hold == delta(A,D,n,k,c,eta,p,V))
    slope = k*(B-n)
    threshold = (V+(eta+k)*D-c)/slope
    dq = delta(A,D,n,k,c,eta,p,V)
    check('T2_ii', slope > 0 and dq-delta(A,D,n,k,c,eta,Q(0),V) == slope*p
          and delta(A,D,n,k,c,eta,threshold,V) == 0 and ((fire<=hold)==(p<=threshold)))
    Vcycle = D**2/(2*g)
    bayes = Vcycle+(eta+(1-p)*k)*D >= p*k*(A-n)+c
    shipped = Vcycle+(eta+(1-p)*k)*D >= p*k*A+c
    pt = (Vcycle+(eta+k)*D-c)/slope
    check('T2_iii', bayes == (delta(A,D,n,k,c,eta,p,Vcycle)<=0)
          and bayes == (p<=pt) and (not shipped or bayes)
          and (p*k*A+c)-(p*k*(A-n)+c)==p*k*n and (n!=0 or shipped==bayes))
    phat = 1-p
    selected = fire if delta(A,D,n,k,c,eta,phat,V)<=0 else hold
    check('T2_vi', selected-min(fire,hold)<=slope*abs(phat-p)<=k*B*abs(phat-p))
    if c==0:
        coldhold = (1+k)*B+eta*D+F
        check('T2_v', fire<coldhold and Vcycle+(eta+k)*D>=0)
    if c==eta==0:
        check('T2_v', (Vcycle>=k*A)==(float(D)>=sqrt(float(2*g*k*A)))
              and (Vcycle>=k*(A-n))==(float(D)>=sqrt(float(2*g*k*(A-n)))))

for D, g in product(map(Q, range(1,8)), map(Q, range(1,5))):
    check('T2_iv_a', g*(D/g)**2/2 == D**2/(2*g))
for g, s in product(map(Q, range(1,5)), range(12)):
    D=g*s
    check('T2_iv_c', sum(g*j for j in range(s+1)) == D**2/(2*g)+D/2)
# Perfect-square fluid thresholds keep warm-value and optimization checks exact.
for g, dstar in product(map(Q, (1,2,3)), map(Q, (1,2,4))):
    rewrite = dstar**2/(2*g)
    for d in map(Q, (Q(1,4),Q(1,2),1,2,3,4,5)):
        check('T2_iv_b', (d**2/(2*g)>=rewrite)==(d>=dstar)
              and rewrite*g/d+d/2>=dstar and rewrite*g/dstar+dstar/2==dstar)
    for frac in map(Q, (Q(1,4),Q(1,2),1)):
        D=dstar*frac
        warm=(dstar*D-D**2/2)/g
        cycle=D**2/(2*g)
        for p in map(Q, (Q(1,4),Q(1,2),Q(3,4))):
            check('T2_vii', warm>=cycle and ((warm==cycle)==(D==dstar))
                  and (not (cycle>=p*rewrite-(1-p)*D) or warm>=p*rewrite-(1-p)*D))
# Hazard formulas are transcendental: numeric screening, explicitly not exact proof.
for g, h, dH in product((0.5,1,3), (0.1,0.5,1), (1,2,5)):
    B=g/h**2*(h*dH/g-1+exp(-h*dH/g))
    ds=sqrt(2*g*B)
    for frac in (0.25,0.5,1):
        D=frac*ds
        VH=D/h-g/h**2*exp(-h*dH/g)*(exp(h*D/g)-1)
        VW=(ds*D-D**2/2)/g
        check('T2_vii', VH<VW, ('hazard',g,h,dH,D))

# Exhaust all comparator schedules and arbitrary guard predicates on small horizons.
for B in map(Q,(1,2,4)):
    for m in range(1,6):
        schedules=list(product((False,True),repeat=m))
        for a in product(map(Q,(0,1,2)),repeat=m):
            opt=min(cost(B,a,s) for s in schedules)
            bal,bal_edits=execute(B,a,'bal')
            for s in schedules:
                comparator=cost(B,a,s)
                check('T4_i', bal<=2*comparator and
                      (not any(bal_edits) or bal<2*comparator))
            for alpha in map(Q,(Q(1,4),Q(1,2),1)):
                for pi in schedules:
                    guarded, edits=execute(B,a,'guard',alpha,
                        pred=lambda history,P,R,pi=pi: pi[len(history)-1])
                    if not any(pi):
                        check('T5_ii', edits == bal_edits and guarded <= 2*opt and
                              (not any(bal_edits) or guarded < 2*opt))
                    check('T5_i', guarded<=(1+1/alpha)*opt and
                          (not any(edits) or guarded<(1+1/alpha)*opt))

for g, B in product(map(Q, (1,2,3)),map(Q,(Q(1,2),1,2,5,10))):
    Lstar=next(L for L in range(1,30) if g*L*(L+1)>=2*B)
    Llaw=next(L for L in range(1,30) if g*L*L>=2*B)
    ell=sqrt(float(2*B/g)); bound=sqrt(float(2*g*B))-float(g/2)
    cstar=rate(B,g,Lstar); claw=rate(B,g,Llaw)
    check('T3_ii', all(cstar<=rate(B,g,j) for j in range(1,50))
          and float(cstar)>=bound-1e-12)
    check('T3_iv', Llaw in (Lstar,Lstar+1) and float(claw)-bound<float(g)/(2*ell)
          and (ell<=0.5 or (float(claw)-bound)/float(cstar)<1/(ell*(2*ell-1))))
    for N in range(1,8):
        a=[g]*N
        for sigma in product((False,True),repeat=N):
            c=cost(B,a,sigma)
            check('T3_i', c>=N*bound-float(B)-1e-12)
            check('T3_ii', c>=N*cstar-B)
        periodic=[(i+1)%Lstar==0 for i in range(N)]
        bal,bal_edits=execute(B,a,'bal')
        law,law_edits=execute(B,a,'law',estimate=lambda _:g)
        check('T3_iii', bal_edits==periodic)
        check('T3_iv', law_edits==[(i+1)%Llaw==0 for i in range(N)])
        check('T3_ii', cost(B,a,periodic)<=N*cstar+B+g*Lstar**2)
        for alpha,G in product(map(Q,(0,Q(1,10),Q(1,2),1)),(g,2*g)):
            guarded,edits=execute(B,a,'guard',alpha,estimate=lambda _:G)
            check('T5_iv', edits==bal_edits==periodic)

# Deterministic lower bound: every possible first-edit time on a single-burst family.
for eps in map(Q,(Q(1,10),Q(1,2),1,3)):
    B=Q(10); D=eps*B
    for t in range(51):
        opt=min(B,(t+1)*D)
        check('T4_ii', t*D+B>=(2-eps)*opt)
    m=int(B/D*(2-eps))+2
    check('T4_ii', m*D>=(2-eps)*min(B,m*D))

# LAW early/late adversaries, with positive known optimal burst costs.
for c in map(Q,(1,2,10,100)):
    G=Q(1); B=Q(8)*(c+1)**2; D=4*(c+1)
    alg,_=execute(B,[D],'law',estimate=lambda _:G)
    check('T4_iv', D<B and alg>c*min(B,D))
    B=Q(10); D=Q(1); m=int(c*B/D)+1
    alg,edits=execute(B,[D]+[Q(0)]*m,'law',estimate=lambda _:G)
    check('T4_iv', not any(edits) and alg>c*min(B,(m+1)*D))

# Both T5 lower-bound families, including alpha=1 and increasing scale.
for alpha,eps,M in product(map(Q,(Q(1,10),Q(1,2),1)),
                            map(Q,(Q(1,10),Q(1,2))),map(Q,(1,10,100))):
    G=Q(1)
    for t in (10,100,1000,10000):
        B=Q(t*t); D=Q(2*t)  # D exceeds sqrt(2GB); D/B tends to zero.
        s=(alpha*B/D).__ceil__()
        opt=min(B,s*D)
        if B>M*G and (s-1)*D+B>=(1+1/alpha-eps)*opt:
            check('T5_ii', True); break
    else:
        check('T5_ii', False,('fixed',alpha,eps,M))
    for B in (1000,10000,100000):
        if B<=M: continue
        s=(alpha*B).__ceil__()
        # Closed-form estimate after the unit burst, evaluated by exact fractions.
        ewma=Q(9,10)**s*2500+Q(1,10)*Q(9,10)**(s-1)
        law=1>=2*ewma*B
        opt=min(B,Q(s))
        if law and (s-1)+B>=(1+1/alpha-eps)*opt:
            check('T5_ii', True); break
    else:
        check('T5_ii', False,('ewma',alpha,eps,M))
for B,G,P,R,alpha in product(map(Q,(1,10,100)),map(Q,(0,1,2)),
                            map(Q,(0,1,2,15)),map(Q,(1,2,15,30)),
                            map(Q,(Q(1,10),Q(1,2),1))):
    if P<=R and P**2>=2*G*B and R<alpha*B:
        check('T5_ii', B>2*G/alpha**2)

# Consistency: fixed-estimate version passes; original online-estimate version fails.
for B,D,alpha,G in product(map(Q,(1,5,10)),map(Q,(1,2,3)),
                            map(Q,(Q(1,10),Q(1,2),1)),map(Q,(0,Q(1,100),1))):
    if D**2<2*G*B: continue
    horizon=int(B/D)+3
    pending=rent=Q(0)
    for i in range(horizon):
        pending+=D if i==0 else 0
        rent+=pending
        if rent>=B or (pending**2>=2*G*B and rent>=alpha*B):
            check('T5_v', i*D+B<(1+alpha)*B)
            break
B=Q(10);D=Q(1);alpha=Q(1,2)
a=[D]+[Q(0)]*10
estimate=lambda history: Q(1,100) if len(history)<=1 else Q(100)
_,edits=execute(B,a,'guard',alpha,estimate)
k=edits.index(True)
first_cycle=cost(B,a[:k+1],edits[:k+1])
check('T5_v', first_cycle<(1+alpha)*B,
      {'B':str(B),'D':str(D),'alpha':str(alpha),'first_edit_request':k+1,
       'cycle_cost':str(first_cycle),'claimed_upper':str((1+alpha)*B)})

for name in sorted(checks, key=lambda n:(int(n.split('_')[0][1:]),n)):
    bad=[i for n,i in failures if n==name]
    print(f'{name}: {checks[name]} checks; {len(bad)} counterexamples')
    for instance in bad:
        print(f'  counterexample: {instance}')
print('Screening only; gate required. Expected finding: T5_v fails for changing estimates.')
assert len(checks)==20, sorted(checks)
assert len(failures)==1 and failures[0][0]=='T5_v', failures
