"""Glicko-2 rating system. Based on Mark Glickman's paper:
http://www.glicko.net/glicko/glicko2.pdf

Each entity has three numbers:
  rating r          (Elo-scale, default 1500)
  rating deviation  (Elo-scale, default 350 for unrated, drops with games)
  volatility sigma  (default 0.06, how much r is allowed to fluctuate)

Per game / period, we update via the iteration in steps 2-8 of Glickman's
appendix. Used by src/backtest_glicko2.py to compare against ELO head-to-head.
"""
from __future__ import annotations

import math

# Glicko-2 conversion: 400/ln(10)
SCALE = 173.7178

# Defaults
DEFAULT_R     = 1500.0
DEFAULT_RD    = 350.0
DEFAULT_SIGMA = 0.06
# System constant — controls how much volatility can change per period.
# Glickman recommends 0.3-1.2; 0.5 is a reasonable default.
TAU = 0.5
# Numerical tolerance for the volatility bisection
EPS = 1e-6


def to_g2(r: float, rd: float) -> tuple[float, float]:
    """Elo-scale (r, RD) → Glicko-2-scale (mu, phi)."""
    return (r - 1500.0) / SCALE, rd / SCALE


def from_g2(mu: float, phi: float) -> tuple[float, float]:
    return mu * SCALE + 1500.0, phi * SCALE


def g(phi: float) -> float:
    """g() shrinks rated-impact based on opponent RD — very uncertain
    opponents contribute less information."""
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi * math.pi))


def E(mu: float, mu_j: float, phi_j: float) -> float:
    """Expected score (win prob, 0-1) of player at mu vs opponent (mu_j, phi_j)."""
    return 1.0 / (1.0 + math.exp(-g(phi_j) * (mu - mu_j)))


def update(r: float, rd: float, sigma: float,
           opponents: list[tuple[float, float, float]]) -> tuple[float, float, float]:
    """Run one rating period for a player.

    opponents: list of (opp_r, opp_rd, score) where score ∈ {0.0, 0.5, 1.0}.
    Returns (new_r, new_rd, new_sigma).

    If the player has no games this period, only RD grows (step 6 with no v).
    """
    mu, phi = to_g2(r, rd)

    if not opponents:
        # No games — RD inflates by volatility (uncertainty grows)
        new_phi = math.sqrt(phi * phi + sigma * sigma)
        new_r, new_rd = from_g2(mu, new_phi)
        return new_r, new_rd, sigma

    # Step 3: variance v (in Glicko-2 scale)
    op = [(to_g2(opr, oprd), s) for opr, oprd, s in opponents]
    v_inv = 0.0
    for ((om, op_), _s) in op:
        e = E(mu, om, op_)
        v_inv += g(op_) ** 2 * e * (1.0 - e)
    if v_inv <= 0:
        v = 1e9
    else:
        v = 1.0 / v_inv

    # Step 4: improvement delta (in Glicko-2 scale)
    delta_inner = 0.0
    for ((om, op_), s) in op:
        e = E(mu, om, op_)
        delta_inner += g(op_) * (s - e)
    delta = v * delta_inner

    # Step 5: new sigma via the bisection from Glickman's appendix
    new_sigma = _volatility(sigma, phi, v, delta)

    # Step 6: pre-period RD
    phi_star = math.sqrt(phi * phi + new_sigma * new_sigma)

    # Step 7: new phi, new mu
    new_phi = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
    new_mu = mu + new_phi * new_phi * delta_inner

    new_r, new_rd = from_g2(new_mu, new_phi)
    return new_r, new_rd, new_sigma


def _volatility(sigma: float, phi: float, v: float, delta: float) -> float:
    """Glicko-2 step 5: solve for new sigma via Illinois-method bisection."""
    a = math.log(sigma * sigma)

    def f(x: float) -> float:
        ex = math.exp(x)
        num = ex * (delta * delta - phi * phi - v - ex)
        den = 2.0 * (phi * phi + v + ex) ** 2
        return num / den - (x - a) / (TAU * TAU)

    # Bracket
    A = a
    if delta * delta > phi * phi + v:
        B = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * TAU) < 0:
            k += 1
            if k > 1000:   # safety
                break
        B = a - k * TAU

    fA, fB = f(A), f(B)
    iters = 0
    while abs(B - A) > EPS:
        iters += 1
        if iters > 1000:   # safety
            break
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB <= 0:
            A, fA = B, fB
        else:
            fA = fA / 2.0
        B, fB = C, fC
    return math.exp(A / 2.0)


# ── Self-test using the example from Glickman's paper appendix ─────────────
if __name__ == '__main__':
    # Player: r=1500, RD=200, sigma=0.06
    # Games: opp 1400 RD=30 won; opp 1550 RD=100 lost; opp 1700 RD=300 lost
    # Expected after: r ≈ 1464.06, RD ≈ 151.52, sigma ≈ 0.05999
    nr, nrd, ns = update(1500, 200, 0.06, [
        (1400,  30, 1.0),
        (1550, 100, 0.0),
        (1700, 300, 0.0),
    ])
    print(f'r:     {nr:.2f}  (expected 1464.06)')
    print(f'RD:    {nrd:.2f} (expected 151.52)')
    print(f'sigma: {ns:.6f} (expected 0.05999)')
