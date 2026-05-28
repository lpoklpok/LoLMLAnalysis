"""
Post-hoc objective-state overlay for the live win-prob model.

The base model (train_live_winprob.py) only sees gold/xp/cs/kill diffs because
OE's free CSV exports objectives as end-of-game totals only. This module adds
a domain-calibrated logit adjustment for objectives present in the lolesports
live feed but absent from the model: dragons, soul, baron buff, inhibitors.

Adjustments are applied in log-odds space on top of the model's output. They
represent the MARGINAL effect of an objective state CONDITIONAL on the gold/xp
the model already saw — so "soul + even gold = 90%" anchors the soul weight
to (logit(0.90) - logit(0.50)) = +2.2 rather than the raw correlation between
soul and winning.

Calibration anchors (hand-set from domain knowledge):
  - Soul + even gold + even skill → ~90% → +2.2 logit
  - Active baron buff + even gold  → ~68% → +0.75 logit
  - 1 inhib lead + even gold        → ~65% → +0.62 logit
  - 2-inhib lead + even gold        → ~80% → +1.4 logit total (capped)
  - Dragon stack 3-vs-0 (no soul)   → small boost → +0.4 logit
  - Baron buff fades 3 min after taken

These are calibratable — update if backtest disagrees.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

# Adjustment weights (logit units). Positive = favours team_a (blue).
SOUL_ADJ         = 2.20  # soul taken (4 same-element drakes)
DRAG_STACK_ADJ   = 0.20  # per drake of lead when below soul threshold (cap at 3 diff)
DRAG_STACK_CAP   = 3     # don't grow past this many drake lead
BARON_ACTIVE_ADJ = 0.75  # baron buff currently active
BARON_DURATION_S = 180   # buff lasts 3 min in game time
INHIB_ADJ        = 0.65  # per inhibitor lead (cap below)
INHIB_CAP        = 2     # cap inhib effect at 2-inhib lead
ELDER_ADJ        = 1.10  # elder dragon buff (rare but huge)
ELDER_DURATION_S = 150


@dataclass
class ObjectiveState:
    blue_dragons:        int = 0
    red_dragons:         int = 0
    blue_has_soul:       bool = False
    red_has_soul:        bool = False
    blue_elder_active:   bool = False  # currently has elder buff
    red_elder_active:    bool = False
    blue_barons:         int = 0
    red_barons:          int = 0
    blue_baron_taken_at: float | None = None  # in-game seconds when last baron taken
    red_baron_taken_at:  float | None = None
    blue_inhibitors:     int = 0
    red_inhibitors:      int = 0
    time_s:              float = 0.0          # current in-game seconds


def _logit(p: float) -> float:
    p = min(max(p, 1e-9), 1 - 1e-9)
    return math.log(p / (1 - p))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def adjustment_logit(o: ObjectiveState) -> float:
    """Compute the additive logit adjustment for blue from objective state."""
    adj = 0.0

    # 1. Soul (4 drakes of same element). Lolesports `dragons` is a list with
    #    elemental types; the caller derives blue_has_soul / red_has_soul.
    if o.blue_has_soul and not o.red_has_soul:
        adj += SOUL_ADJ
    elif o.red_has_soul and not o.blue_has_soul:
        adj -= SOUL_ADJ
    else:
        # No soul yet — score a small stack-lead bump
        diff = min(max(o.blue_dragons - o.red_dragons, -DRAG_STACK_CAP), DRAG_STACK_CAP)
        adj += diff * DRAG_STACK_ADJ

    # 2. Elder dragon buff
    if o.blue_elder_active and not o.red_elder_active:
        adj += ELDER_ADJ
    elif o.red_elder_active and not o.blue_elder_active:
        adj -= ELDER_ADJ

    # 3. Baron buff (active only if taken within last BARON_DURATION_S)
    def baron_active(taken_at: float | None) -> bool:
        return taken_at is not None and (o.time_s - taken_at) <= BARON_DURATION_S
    b_active = baron_active(o.blue_baron_taken_at)
    r_active = baron_active(o.red_baron_taken_at)
    if b_active and not r_active:
        adj += BARON_ACTIVE_ADJ
    elif r_active and not b_active:
        adj -= BARON_ACTIVE_ADJ

    # 4. Inhibitors (capped)
    inh_diff = min(max(o.blue_inhibitors - o.red_inhibitors, -INHIB_CAP), INHIB_CAP)
    adj += inh_diff * INHIB_ADJ

    return adj


def apply_overlay(p_model: float, objectives: ObjectiveState) -> tuple[float, float]:
    """Apply objective overlay to model output.

    Returns (p_adjusted, logit_delta) — logit_delta is the adjustment that
    was applied, useful for debugging "where did the prob come from".
    """
    delta = adjustment_logit(objectives)
    p_adj = _sigmoid(_logit(p_model) + delta)
    return p_adj, delta


# ----------------- frame helpers -----------------
class BaronTracker:
    """Tracks when each team last took their nth baron from a stream of frames,
    so we can decide whether the buff is still active.

    Use:
        t = BaronTracker()
        for frame in frames:
            t.update(frame, in_game_seconds)
        objs = t.snapshot(in_game_seconds, dragons_blue=[...], dragons_red=[...])
    """
    def __init__(self) -> None:
        self.blue_count: int = 0
        self.red_count:  int = 0
        self.blue_last_at: float | None = None
        self.red_last_at:  float | None = None

    def update(self, frame: dict, time_s: float) -> None:
        bb = int((frame.get("blueTeam") or {}).get("barons") or 0)
        rr = int((frame.get("redTeam")  or {}).get("barons") or 0)
        if bb > self.blue_count:
            self.blue_last_at = time_s
            self.blue_count = bb
        if rr > self.red_count:
            self.red_last_at = time_s
            self.red_count = rr


def derive_soul(dragons_list: list[str | dict] | None) -> tuple[int, bool]:
    """Lolesports `dragons` is a list of strings (one per drake taken) like
    ['infernal','ocean','cloud','infernal']. Soul = ≥4 of the SAME element
    (chemtech/cloud/hextech/infernal/mountain/ocean). Elder is separate.

    Returns (drake_count_excluding_elder, has_soul).
    """
    if not dragons_list:
        return 0, False
    elements: dict[str, int] = {}
    n = 0
    for d in dragons_list:
        name = d if isinstance(d, str) else (d.get("name") or d.get("type") or "")
        if not name or "elder" in name.lower():
            continue
        n += 1
        key = name.lower()
        elements[key] = elements.get(key, 0) + 1
    has_soul = any(c >= 4 for c in elements.values())
    return n, has_soul


def derive_elder_active(dragons_list: list[str | dict] | None, time_s: float,
                        last_elder_at: float | None) -> bool:
    """Elder buff lasts ELDER_DURATION_S. Requires caller to track when elder
    was last taken (since the cumulative dragons list doesn't carry a timestamp).
    """
    return last_elder_at is not None and (time_s - last_elder_at) <= ELDER_DURATION_S


if __name__ == "__main__":
    # Smoke tests against domain anchors
    print("== Smoke tests ==")

    # 1. Soul + even gold + even prior → expect ~90%
    o = ObjectiveState(blue_has_soul=True, blue_dragons=4, red_dragons=1, time_s=28*60)
    p, d = apply_overlay(0.50, o)
    print(f"  soul + even (p_model=0.50): p_adj={p:.3f}  Δlogit={d:+.2f}  (target ~0.90)")

    # 2. Baron buff + small gold lead
    o = ObjectiveState(blue_baron_taken_at=22*60, time_s=23*60)
    p, d = apply_overlay(0.55, o)
    print(f"  baron active + 0.55 model:  p_adj={p:.3f}  Δlogit={d:+.2f}  (target ~0.70)")

    # 3. 2-inhib lead from even gold
    o = ObjectiveState(blue_inhibitors=2, red_inhibitors=0, time_s=30*60)
    p, d = apply_overlay(0.50, o)
    print(f"  2 inhib lead (p_model=0.50): p_adj={p:.3f}  Δlogit={d:+.2f}  (target ~0.80)")

    # 4. Behind on gold but you have soul (rare)
    o = ObjectiveState(blue_has_soul=True, time_s=28*60)
    p, d = apply_overlay(0.30, o)
    print(f"  soul but behind (p_model=0.30): p_adj={p:.3f}  Δlogit={d:+.2f}")

    # 5. Soul vs counter-soul (both have 4 same-element)
    o = ObjectiveState(blue_has_soul=True, red_has_soul=True, time_s=30*60)
    p, d = apply_overlay(0.50, o)
    print(f"  both soul (impossible normally): p_adj={p:.3f}  Δlogit={d:+.2f}")

    # 6. Dragon stack 3-0 no soul yet
    o = ObjectiveState(blue_dragons=3, red_dragons=0, time_s=20*60)
    p, d = apply_overlay(0.55, o)
    print(f"  3-0 drakes (no soul): p_adj={p:.3f}  Δlogit={d:+.2f}")

    # 7. Elemental drake test
    drakes = ["infernal", "cloud", "infernal", "infernal", "infernal"]
    n, soul = derive_soul(drakes)
    print(f"  derive_soul(['infernal','cloud','infernal','infernal','infernal']): n={n} soul={soul}")
