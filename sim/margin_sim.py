"""Monte Carlo margin simulation for Shoal's sealed, Shoal-paid API trials.

Every price below comes from server/src/trials.js. Run counts come from
verifier.js, proof.js, scanner.js and survival.js. Behavioural numbers
(solve rates, fake-fix rates, unlock rate...) are ASSUMPTIONS, flagged as
such, and varied in the sensitivity section.

    python3 margin_sim.py            -> prints tables, writes results.json
"""
import json
import math
import sys

import numpy as np

N = 20_000          # bugs per scenario
SEED = 7

# ---- Prices, $ per million tokens: input, output (trials.js) ----------------
PRICE = {
    "gpt-5-nano": (0.05, 0.4),
    "claude-haiku-5-5": (0.1, 0.5),
    "gpt-6-luna": (0.1, 0.5),
    "claude-sonnet-5-5": (2, 10),
    "gpt-6.1-sol": (2, 10),
    "claude-opus-5-5": (4, 20),
    "gpt-6-astra": (10, 50),
}
# ASSUMPTION: relative skill on flaky-test bugs (logit scale vs bug difficulty).
SKILL = {
    "gpt-5-nano": -1.0,
    "claude-haiku-5-5": -0.2,
    "gpt-6-luna": -0.2,
    "claude-sonnet-5-5": 0.9,
    "gpt-6.1-sol": 0.9,
    "claude-opus-5-5": 1.5,
    "gpt-6-astra": 1.7,
}
STEPS = [
    ["claude-haiku-5-5", "gpt-6-luna", "gpt-5-nano"],
    ["claude-sonnet-5-5", "gpt-6.1-sol"],
    ["claude-opus-5-5", "gpt-6-astra"],
]
ALL_MODELS = [m for s in STEPS for m in s]

SANDBOX_PER_SEC = 0.10 / 3600   # ASSUMPTION: $0.10/h per 2-vCPU run slot
STRIPE_PCT, STRIPE_FIXED, CREDIT_PACK = 0.029, 0.30, 50.0  # fee spread over a $50 credit pack


def tok_cost(model, tin, tout):
    i, o = PRICE[model]
    return (tin * i + tout * o) / 1e6


def lognorm(rng, median, sigma, size, cap=None):
    x = rng.lognormal(math.log(median), sigma, size)
    return np.minimum(x, cap) if cap else x


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


# Verification runs scaled to the failure rate (verifier.js verifyRuns, brief 4.7).
def verify_runs(flake, adaptive):
    if not adaptive or flake <= 0 or flake >= 1:
        return 10
    return min(150, max(10, math.ceil(math.log(0.05) / math.log(1 - flake))))


# ---- One shared set of bugs (common random numbers across scenarios) -------
def make_bugs(rng, n, *, difficulty_shift=0.0, ctx_all_median=50_000, unlock=0.6, commits_median=5):
    return {
        "d": rng.normal(difficulty_shift, 1.0, n),                 # bug difficulty
        "flake": np.clip(rng.beta(1.5, 10, n), 0.02, 0.6),         # failure rate at scan
        "ctx_fix": lognorm(rng, 12_000, 0.7, n, 150_000),          # failing test + its imports
        "ctx_all": lognorm(rng, ctx_all_median, 1.0, n, 600_000),  # ALL shared code (proof.js before 4.5)
        "file_out": lognorm(rng, 2_500, 0.8, n, 16_000),           # full changed files (FixSchema today)
        "t_file": lognorm(rng, 6, 0.9, n, 180),                    # seconds per single-test-file run
        "files": np.maximum(3, lognorm(rng, 60, 0.8, n, 2_000)).astype(int),
        "window": rng.choice([7, 10, 14], n),
        "commits": lognorm(rng, commits_median, 0.8, n, 60),
        "u_unlock": rng.random(n), "unlock": unlock,
        # per model per bug uniform draws, so every scenario sees the same luck
        "u_model": {m: rng.random((n, 5)) for m in ALL_MODELS},
        "u_reason": {m: rng.lognormal(0, 0.8, n) for m in ALL_MODELS},
        "u_misc": rng.random((n, 8)),
    }


DESIGNS = {
    # Today's trial shape moved onto the API: every model at once, Opus
    # writes challenge tests, Sonnet + Astra judge every candidate even after
    # it failed a test, full-file output, high effort, all-code context.
    "S0_today_on_api": dict(ladder=False, writer="claude-opus-5-5", judges=("claude-sonnet-5-5", "gpt-6-astra"),
                            judge_after_tests=False, isolated=False, trim=False, edits=False, low_effort_step1=False),
    # The owner's picks: escalation ladder, no same-model retry, Sonnet writes
    # challenge tests (models hidden), judges only after the tests pass,
    # every run in its own sandbox copy.
    "S1_your_choices": dict(ladder=True, writer="claude-sonnet-5-5", judges=("claude-sonnet-5-5", "gpt-6-astra"),
                            judge_after_tests=True, isolated=True, trim=False, edits=False, low_effort_step1=False),
    # S1 plus the optional savings: proof gets only the relevant files,
    # search/replace edits, low effort on step 1, GPT-6.1 Sol as the OpenAI
    # judge instead of Astra.
    "S2_plus_optional": dict(ladder=True, writer="claude-sonnet-5-5", judges=("claude-sonnet-5-5", "gpt-6.1-sol"),
                             judge_after_tests=True, isolated=True, trim=True, edits=True, low_effort_step1=True),
    # What was built (Elijah-dev): S2's trimmed context + Sol judge, plus
    # verification runs scaled to the failure rate (4.7). Full-file fixes and
    # high effort are kept (edits / low effort weren't approved; ~1 point each).
    "S3_built": dict(ladder=True, writer="claude-sonnet-5-5", judges=("claude-sonnet-5-5", "gpt-6.1-sol"),
                     judge_after_tests=True, isolated=True, trim=True, edits=False, low_effort_step1=False,
                     adaptive_verify=True),
}

# ASSUMPTIONS on fix behaviour
FAKE_SHARE = 0.30        # of non-fixes, share that hide the symptom instead of failing outright
REAL_PASS_VERIFY = 0.97  # sandbox noise
REAL_PASS_PROOF = 0.90   # stress + suite + challenge tests
REAL_PASS_JUDGES = 0.88  # both judges
FAKE_PASS_JUDGES = 0.25
FAKE_CHALLENGE_CATCH = 0.70
REGRESS_REAL, REGRESS_FAKE = 0.04, 0.70


def simulate(bugs, design, cap=2.0):
    n = len(bugs["d"])
    rows = []
    for b in range(n):
        d, flake = bugs["d"][b], bugs["flake"][b]
        ctx_fix, ctx_all = bugs["ctx_fix"][b], bugs["ctx_all"][b]
        t, files = bugs["t_file"][b], bugs["files"][b]
        k = max(1, round(files * 0.05))                       # flaky files in the repo
        suite_t = 0.4 * files * t
        copy_t = 1.5 if design["isolated"] else 0.0            # per-run sandbox copy
        run = lambda count, dur=t: count * (dur + copy_t)      # seconds of sandbox time
        cost = dict(fix=0.0, writer=0.0, judges=0.0, scan=0.0, verify=0.0, proof=0.0, survival=0.0)
        cost["scan"] = run(10 * files / k) * SANDBOX_PER_SEC   # 10 runs of every file, shared by k bugs
        vruns = verify_runs(flake, design.get("adaptive_verify", False))

        steps = STEPS if design["ladder"] else [ALL_MODELS]
        proven = None
        proven_step = None
        for si, models in enumerate(steps):
            if design["ladder"] and si > 0 and sum(cost.values()) > cap:
                break
            verified = []
            for m in models:
                u = bugs["u_model"][m][b]
                effort_low = design["low_effort_step1"] and design["ladder"] and si == 0
                reasoning = (1_500 if effort_low else 6_000) * bugs["u_reason"][m][b]
                out = (400 if design["edits"] else bugs["file_out"][b]) + 300
                cost["fix"] += tok_cost(m, ctx_fix + 1_500, min(out + reasoning, 16_000 + reasoning))
                p_real = sigmoid(1.6 * (SKILL[m] - d))
                if u[0] < p_real:
                    kind = "real"
                elif u[1] < FAKE_SHARE:
                    kind = "fake"
                else:
                    kind = "broken"
                # verifier: vruns runs (+ suite once when it passes); a failing
                # fix stops at its first failing batch (about 10 runs)
                p_ver = REAL_PASS_VERIFY if kind == "real" else (1 - flake * 0.5) ** vruns if kind == "fake" else 0.0
                passed = u[2] < p_ver
                cost["verify"] += run(vruns if passed else min(10, vruns)) * SANDBOX_PER_SEC
                if passed:
                    cost["verify"] += run(1, suite_t) * SANDBOX_PER_SEC
                    verified.append((m, kind, (u[3], u[4])))
            if not verified:
                continue
            # cheapest first (optimizer: cheapest within 5 quality points)
            verified.sort(key=lambda v: tok_cost(v[0], 25_000, 3_000))
            # challenge tests written once per new candidate set; run 3x per fix + original
            proof_ctx = (ctx_fix * 1.3 + 3_000) if design["trim"] else ctx_all
            w = design["writer"]
            cost["writer"] += tok_cost(w, proof_ctx + 2_000 * len(verified), 3_000 + 4_000 * bugs["u_reason"][w][b])
            cost["proof"] += run(3 * (len(verified) + 1)) * SANDBOX_PER_SEC
            for m, kind, u in verified:
                # stress: 40 target runs + 10 shuffled full-suite runs; then suite + other flaky files x10
                cost["proof"] += (run(40) + run(10, suite_t) + run(1, suite_t) + run(10 * (k - 1))) * SANDBOX_PER_SEC
                p_det = REAL_PASS_PROOF if kind == "real" else ((1 - flake * 0.5) ** 50) * (1 - FAKE_CHALLENGE_CATCH)
                det_ok = u[0] < p_det
                if det_ok or not design["judge_after_tests"]:
                    for j in design["judges"]:
                        jm = j if j != m else ("claude-opus-5-5" if j.startswith("claude") else "gpt-6.1-sol")
                        reasoning = (4_000 if PRICE[jm][1] >= 10 and "gpt" in jm else 1_000) * bugs["u_reason"][jm][b]
                        cost["judges"] += tok_cost(jm, proof_ctx + 2_000, 600 + reasoning)
                p_j = REAL_PASS_JUDGES if kind == "real" else FAKE_PASS_JUDGES
                if det_ok and u[1] < p_j:
                    proven, proven_step = (m, kind), si
                    break
            if proven:
                break

        misc = bugs["u_misc"][b]
        sold = proven is not None and bugs["u_unlock"][b] < bugs["unlock"]
        clawed = False
        if sold:
            checks = bugs["window"][b] * (4 + bugs["commits"][b])
            regress = REGRESS_REAL if proven[1] == "real" else REGRESS_FAKE
            clawed = misc[0] < regress
            # 10 runs per check, +20 on any failure (assume 5% of checks of a real fix see one)
            extra = 20 * checks * (0.05 if not clawed else 0.3)
            done = checks * (misc[1] if clawed else 1.0)
            cost["survival"] = run(10 * done + extra) * SANDBOX_PER_SEC
        rows.append(dict(cost=cost, total=sum(cost.values()), proven=proven is not None,
                         step=proven_step, sold=sold, clawed=clawed, fake=bool(proven and proven[1] == "fake")))
    return rows


def price_for(row, pricing):
    if pricing["kind"] == "flat":
        return pricing["price"]
    if pricing["kind"] == "dynamic":
        return dynamic_price(row, pricing)
    return pricing["tiers"][row["step"]] if row["step"] is not None else 0


# Dynamic pricing: this bug's cost up to the moment the fix is proven (what
# Shoal knows before the team unlocks; survival compute comes later) times
# a markup, rounded up to .99, between a floor and a ceiling. Mirrors
# server/src/pricing.js.
def dynamic_price(row, pricing):
    known = row["total"] - row["cost"]["survival"]
    raw = pricing["base"] + known * pricing["markup"]
    p = math.ceil(raw) - 0.01
    return min(pricing["ceiling"], max(pricing["floor"], p))


def economics(rows, pricing, fixed_month=0.0):
    revenue = refunds = fees = 0.0
    loss_sales = 0
    for r in rows:
        if not r["sold"]:
            continue
        p = price_for(r, pricing)
        revenue += p
        fees += p * STRIPE_PCT + STRIPE_FIXED * p / CREDIT_PACK
        if r["clawed"]:
            refunds += p
        if p < r["total"]:
            loss_sales += 1
    cost = sum(r["total"] for r in rows)
    sold = sum(r["sold"] for r in rows)
    kept = revenue - refunds
    profit = kept - fees - cost - fixed_month
    return dict(
        revenue=revenue, refunds=refunds, fees=fees, cost=cost, profit=profit,
        gross_margin=(profit / kept) if kept else float("nan"),
        profit_per_bug=profit / len(rows), profit_per_sale=profit / max(1, sold),
        sales_below_own_cost=loss_sales / max(1, sold),
        avg_price=revenue / max(1, sold),
    )


def summary(rows):
    tot = np.array([r["total"] for r in rows])
    sold = [r for r in rows if r["sold"]]
    cats = rows[0]["cost"].keys()
    return dict(
        cost_per_bug_mean=float(tot.mean()), cost_p50=float(np.percentile(tot, 50)),
        cost_p95=float(np.percentile(tot, 95)), cost_p99=float(np.percentile(tot, 99)), cost_max=float(tot.max()),
        proven_rate=float(np.mean([r["proven"] for r in rows])),
        sold_rate=float(np.mean([r["sold"] for r in rows])),
        clawback_rate_of_sold=float(np.mean([r["clawed"] for r in sold])) if sold else 0.0,
        fake_share_of_proven=float(np.mean([r["fake"] for r in rows if r["proven"]])),
        step_mix=[float(np.mean([r["step"] == s for r in rows if r["proven"]])) for s in range(3)],
        cost_per_sale=float(tot.sum() / max(1, len(sold))),
        breakdown={c: float(np.mean([r["cost"][c] for r in rows])) for c in cats},
    )


def breakeven_flat(rows):
    cost = sum(r["total"] for r in rows)
    kept_share = sum(1 for r in rows if r["sold"] and not r["clawed"])
    sold = sum(r["sold"] for r in rows)
    # profit = p*kept - p*fee_rate*sold - cost = 0
    fee_rate = STRIPE_PCT + STRIPE_FIXED / CREDIT_PACK
    return cost / (kept_share - fee_rate * sold)


PRICINGS = {
    "flat_3.99": dict(kind="flat", price=3.99),
    "flat_4.99": dict(kind="flat", price=4.99),
    "flat_7.99": dict(kind="flat", price=7.99),
    "tiered_2.99_5.99_11.99": dict(kind="tiered", tiers=[2.99, 5.99, 11.99]),
    "tiered_3.49_6.99_14.99": dict(kind="tiered", tiers=[3.49, 6.99, 14.99]),
}


def months(rows, pricing, bugs_per_month, fixed, n_months=2_000, seed=11):
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_months):
        pick = [rows[i] for i in rng.integers(0, len(rows), bugs_per_month)]
        out.append(economics(pick, pricing, fixed)["profit"])
    out = np.array(out)
    return dict(mean=float(out.mean()), p5=float(np.percentile(out, 5)), p_loss=float(np.mean(out < 0)))


def diy_opus(bugs, rng):
    """A team running Opus 5.5 in its own agent: ~400K input (80% cache reads),
    ~25K output per session, up to 3 sessions; no stress test, no guarantee."""
    costs, solved = [], 0
    for b in range(len(bugs["d"])):
        c = 0.0
        for _ in range(3):
            tin = rng.lognormal(math.log(400_000), 0.6)
            tout = rng.lognormal(math.log(25_000), 0.6)
            c += (tin * 0.2 * 4 + tin * 0.8 * 0.4 + tout * 20) / 1e6
            if rng.random() < sigmoid(1.6 * (SKILL["claude-opus-5-5"] - bugs["d"][b])):
                solved += 1
                break
        costs.append(c)
    return dict(cost_per_bug=float(np.mean(costs)), cost_per_solved=float(np.sum(costs) / max(1, solved)), solve_rate=solved / len(costs))


def main():
    rng = np.random.default_rng(SEED)
    bugs = make_bugs(rng, N)
    results = {"assumptions": {
        "skill": SKILL, "fake_share": FAKE_SHARE, "unlock_rate": 0.6, "sandbox_per_hour": 0.10,
        "ctx_fix_median": 12_000, "ctx_all_median": 50_000, "spend_cap_before_next_step": 2.0}, "scenarios": {}}
    rows_by = {}
    for name, design in DESIGNS.items():
        rows = simulate(bugs, design)
        rows_by[name] = rows
        s = summary(rows)
        s["breakeven_flat_price"] = breakeven_flat(rows)
        s["pricing"] = {p: economics(rows, pr) for p, pr in PRICINGS.items()}
        results["scenarios"][name] = s

    # monthly risk for S1 (what the user picked), $300/month fixed hosting
    s1 = rows_by["S1_your_choices"]
    results["monthly_S1"] = {
        f"{p}@{v}bugs": months(s1, PRICINGS[p], v, 300.0, n_months=500)
        for p in ["flat_4.99", "tiered_3.49_6.99_14.99"] for v in [50, 200, 1000]
    }

    # sensitivity on S1 with tiered 3.49/6.99/14.99, one knob at a time
    sens = {}
    knobs = {
        "baseline": {},
        "unlock 30%": dict(unlock=0.3),
        "unlock 80%": dict(unlock=0.8),
        "bugs harder (+0.7)": dict(difficulty_shift=0.7),
        "bugs easier (-0.5)": dict(difficulty_shift=-0.5),
        "big repos (ctx_all 200K)": dict(ctx_all_median=200_000),
        "busy repos (20 commits/day)": dict(commits_median=20),
    }
    for label, kw in knobs.items():
        r2 = simulate(make_bugs(np.random.default_rng(SEED), 6_000, **kw), DESIGNS["S1_your_choices"])
        e = economics(r2, PRICINGS["tiered_3.49_6.99_14.99"])
        sm = summary(r2)
        sens[label] = dict(margin=e["gross_margin"], profit_per_bug=e["profit_per_bug"], cost_per_sale=sm["cost_per_sale"],
                           sold_rate=sm["sold_rate"], breakeven_flat=breakeven_flat(r2), below_cost=e["sales_below_own_cost"])
    results["sensitivity_S1_tiered"] = sens
    results["diy_opus_team"] = diy_opus(bugs, np.random.default_rng(3))

    out = sys.argv[1] if len(sys.argv) > 1 else "results.json"
    with open(out, "w") as f:
        json.dump(results, f, indent=1)
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
