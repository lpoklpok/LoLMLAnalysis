"""
Inference helper for the live win-prob model.

Usage:
  from live_winprob import LiveWinProbModel
  m = LiveWinProbModel.load()
  p_blue = m.predict(
      time_min=17.3,
      gold_diff=2150,
      xp_diff=900,
      cs_diff=24,
      kill_diff=2,
      prior_p_blue=0.62,
  )

The model was trained on snapshots at minutes 10/15/20/25 — time_min is
clipped to [10, 25] for stability before that range (no in-game signal
yet, fall back to prior) and after (extrapolation gets noisy).
"""
from __future__ import annotations

import math
import pickle
from pathlib import Path
from typing import NamedTuple

import numpy as np

DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "processed" / "live_winprob" / "model.pkl"
EPS = 1e-4


class LiveWinProbModel:
    def __init__(self, scaler, clf, features: list[str]) -> None:
        self.scaler = scaler
        self.clf = clf
        self.features = features

    @classmethod
    def load(cls, path: Path | str = DEFAULT_MODEL_PATH) -> "LiveWinProbModel":
        with open(path, "rb") as f:
            d = pickle.load(f)
        return cls(d["scaler"], d["clf"], d["features"])

    def predict(self, time_min: float, gold_diff: float, xp_diff: float,
                cs_diff: float, kill_diff: int, prior_p_blue: float) -> float:
        # Before minute 10 there's no in-game signal in training data; fall back to prior.
        if time_min < 10.0:
            return float(prior_p_blue)
        t = min(time_min, 25.0)
        p_prior = min(max(prior_p_blue, EPS), 1 - EPS)
        logit_prior = math.log(p_prior / (1 - p_prior))
        gold_k = gold_diff / 1000.0
        xp_k   = xp_diff   / 1000.0
        x = np.array([[
            logit_prior,
            gold_k,
            xp_k,
            cs_diff,
            kill_diff,
            t,
            gold_k * t,
            xp_k   * t,
            kill_diff * t,
        ]])
        x_s = self.scaler.transform(x)
        return float(self.clf.predict_proba(x_s)[0, 1])


class FrameStats(NamedTuple):
    time_min:  float
    gold_diff: float
    xp_diff:   float
    cs_diff:   float
    kill_diff: int


def frame_to_stats(frame: dict, anchor_seconds: float) -> FrameStats:
    """Pull team-level stats from a lolesports /window frame.

    `anchor_seconds` is the unix-seconds timestamp of game start (from the
    first frame's rfc460Timestamp), so we can derive in-game clock.
    """
    import datetime as dt
    ts = dt.datetime.strptime(frame["rfc460Timestamp"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
    time_min = (ts.timestamp() - anchor_seconds) / 60.0
    b, r = frame["blueTeam"], frame["redTeam"]
    gold_diff = (b.get("totalGold", 0) or 0) - (r.get("totalGold", 0) or 0)
    kill_diff = (b.get("totalKills", 0) or 0) - (r.get("totalKills", 0) or 0)
    # Aggregate XP and CS from participants
    b_xp = sum((p.get("level", 0) or 0) for p in (b.get("participants") or []))
    r_xp = sum((p.get("level", 0) or 0) for p in (r.get("participants") or []))
    b_cs = sum((p.get("creepScore", 0) or 0) for p in (b.get("participants") or []))
    r_cs = sum((p.get("creepScore", 0) or 0) for p in (r.get("participants") or []))
    # /window doesn't expose per-player XP, only level. Approximate XP via level (rough).
    # Level deltas as a proxy — multiply by ~700 to roughly scale to XP units.
    xp_diff = (b_xp - r_xp) * 700
    cs_diff = b_cs - r_cs
    return FrameStats(time_min, float(gold_diff), float(xp_diff), float(cs_diff), int(kill_diff))


if __name__ == "__main__":
    # Smoke test
    m = LiveWinProbModel.load()
    p = m.predict(time_min=20, gold_diff=3000, xp_diff=1500, cs_diff=40, kill_diff=4, prior_p_blue=0.55)
    print(f"smoke test: even-prior, +3k gold +1.5k xp +40 cs +4 k at 20min → p_blue={p:.4f}")
    p = m.predict(time_min=20, gold_diff=-3000, xp_diff=-1500, cs_diff=-40, kill_diff=-4, prior_p_blue=0.55)
    print(f"             same but flipped                                  → p_blue={p:.4f}")
    p = m.predict(time_min=10, gold_diff=0, xp_diff=0, cs_diff=0, kill_diff=0, prior_p_blue=0.7)
    print(f"             zeros at 10min with prior 0.7                     → p_blue={p:.4f}")
