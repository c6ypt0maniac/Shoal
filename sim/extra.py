import json, numpy as np
import margin_sim as M
rng=np.random.default_rng(M.SEED); bugs=M.make_bugs(rng, 8000)
base=M.DESIGNS["S1_your_choices"]
variants={
 "S1": {}, "S1 + trim proof context": dict(trim=True), "S1 + Sol judge (not Astra)": dict(judges=("claude-sonnet-5-5","gpt-6.1-sol")),
 "S1 + search/replace edits": dict(edits=True), "S1 + low effort step 1": dict(low_effort_step1=True),
 "S1 + trim + Sol judge": dict(trim=True, judges=("claude-sonnet-5-5","gpt-6.1-sol")),
}
out={"attribution":{}, "sens_S2":{}, "monthly_S2":{}, "breakeven_volume":{}}
T=M.PRICINGS["tiered_3.49_6.99_14.99"]
for k,v in variants.items():
    rows=M.simulate(bugs, {**base, **v}); s=M.summary(rows); e=M.economics(rows,T)
    out["attribution"][k]=dict(cost_bug=s["cost_per_bug_mean"], judges=s["breakdown"]["judges"], writer=s["breakdown"]["writer"], fix=s["breakdown"]["fix"], margin=e["gross_margin"], breakeven=M.breakeven_flat(rows), p99=s["cost_p99"])
S2=M.DESIGNS["S2_plus_optional"]
knobs={"baseline":{}, "unlock 30%":dict(unlock=0.3), "unlock 80%":dict(unlock=0.8), "bugs harder (+0.7)":dict(difficulty_shift=0.7), "bugs easier (-0.5)":dict(difficulty_shift=-0.5), "big repos (ctx_all 200K)":dict(ctx_all_median=200_000), "busy repos (20 commits/day)":dict(commits_median=20)}
for lab,kw in knobs.items():
    r2=M.simulate(M.make_bugs(np.random.default_rng(M.SEED),6000,**kw), S2)
    for pn in ["flat_3.99","tiered_3.49_6.99_14.99"]:
        e=M.economics(r2,M.PRICINGS[pn]); s=M.summary(r2)
        out["sens_S2"][f"{lab} | {pn}"]=dict(margin=e["gross_margin"], cost_per_sale=s["cost_per_sale"], breakeven=M.breakeven_flat(r2), below_cost=e["sales_below_own_cost"])
rows2=M.simulate(bugs,S2); rows1=M.simulate(bugs,base)
for name,rows in [("S1",rows1),("S2",rows2)]:
    for pn in ["flat_3.99","tiered_3.49_6.99_14.99"]:
        e=M.economics(rows,M.PRICINGS[pn]); per=e["profit"]/len(rows)
        out["breakeven_volume"][f"{name} {pn}"]= (300/per) if per>0 else None
for pn in ["flat_3.99","tiered_3.49_6.99_14.99"]:
    for v in [50,200,1000]:
        out["monthly_S2"][f"{pn}@{v}"]=M.months(rows2,M.PRICINGS[pn],v,300.0,n_months=500)
json.dump(out,open("results_extra.json","w"),indent=1)
for sec,d in out.items():
    print("\n==",sec)
    for k,v in d.items(): print(f"  {k:48}", {a:(round(b,3) if isinstance(b,float) else b) for a,b in v.items()} if isinstance(v,dict) else (round(v) if v else v))
