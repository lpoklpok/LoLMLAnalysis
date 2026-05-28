"""
Fit the live win-prob model.

Features (all known at snapshot time, no forward-looking info):
  - logit_prior  : logit of pre-game p_blue (Bayesian anchor)
  - gold_diff_k  : (blue_gold - red_gold) / 1000
  - xp_diff_k    : (blue_xp - red_xp) / 1000
  - cs_diff      : blue_cs - red_cs
  - kill_diff    : blue_kills - red_kills
  - time_min     : snapshot minute
  - time*gold    : gold leads compound late game

Target: blue_wins (1 if blue won, else 0)

CV: 5-fold by game_id (all 4 snapshots of a game stay together to avoid
leakage). Plus a time-based holdout (last 20% of games chronologically).

Outputs:
  models/live_winprob.pkl       — sklearn LogisticRegression + scaler
  models/live_winprob.json      — calibration / CV summary
"""
import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler


FRAMES_PATH = Path("data/processed/live_winprob/frames.csv")
MODEL_PATH  = Path("data/processed/live_winprob/model.pkl")
META_PATH   = Path("data/processed/live_winprob/model.json")
EPS         = 1e-4


def featurize(df: pd.DataFrame) -> np.ndarray:
    prior = df["prior_p_blue"].clip(EPS, 1 - EPS)
    logit_prior = np.log(prior / (1 - prior))
    gold_k = df["gold_diff"] / 1000.0
    xp_k   = df["xp_diff"]   / 1000.0
    cs     = df["cs_diff"]
    kd     = df["kill_diff"]
    t      = df["time_min"]
    X = np.column_stack([
        logit_prior,
        gold_k,
        xp_k,
        cs,
        kd,
        t,
        gold_k * t,    # gold leads matter more later
        xp_k * t,
        kd * t,
    ])
    return X


def main() -> None:
    frames = pd.read_csv(FRAMES_PATH)
    frames["date"] = pd.to_datetime(frames["date"], utc=True)
    print(f"frames: {len(frames)} ({frames['gameid'].nunique()} games)")

    X = featurize(frames)
    y = frames["blue_wins"].values
    groups = frames["gameid"].values

    feat_names = [
        "logit_prior", "gold_diff_k", "xp_diff_k", "cs_diff", "kill_diff",
        "time_min", "gold_k*t", "xp_k*t", "kd*t",
    ]

    # ---------- 5-fold CV by game ----------
    kf = GroupKFold(n_splits=5)
    cv_pred = np.zeros(len(y))
    fold_metrics = []
    for fold, (tr, te) in enumerate(kf.split(X, y, groups=groups), 1):
        scaler = StandardScaler().fit(X[tr])
        Xtr_s, Xte_s = scaler.transform(X[tr]), scaler.transform(X[te])
        clf = LogisticRegression(C=1.0, max_iter=1000)
        clf.fit(Xtr_s, y[tr])
        p = clf.predict_proba(Xte_s)[:, 1]
        cv_pred[te] = p
        ll = log_loss(y[te], p, labels=[0, 1])
        br = brier_score_loss(y[te], p)
        fold_metrics.append({"fold": fold, "n": len(te), "logloss": float(ll), "brier": float(br)})
        print(f"  fold {fold}: n={len(te):4d}  logloss={ll:.4f}  brier={br:.4f}")

    overall_ll = log_loss(y, cv_pred, labels=[0, 1])
    overall_br = brier_score_loss(y, cv_pred)
    print(f"\nCV overall: logloss={overall_ll:.4f}  brier={overall_br:.4f}")

    # ---------- Baseline: prior alone (no live signal) ----------
    base_p = frames["prior_p_blue"].clip(EPS, 1 - EPS).values
    base_ll = log_loss(y, base_p, labels=[0, 1])
    base_br = brier_score_loss(y, base_p)
    print(f"baseline (prior only): logloss={base_ll:.4f}  brier={base_br:.4f}")
    print(f"lift on logloss: {base_ll - overall_ll:+.4f}")

    # ---------- Per-snapshot breakdown ----------
    print("\nper-snapshot CV metrics:")
    for m in sorted(frames["time_min"].unique()):
        idx = frames["time_min"] == m
        ll_m = log_loss(y[idx], cv_pred[idx], labels=[0, 1])
        br_m = brier_score_loss(y[idx], cv_pred[idx])
        ll_b = log_loss(y[idx], base_p[idx], labels=[0, 1])
        print(f"  min {int(m):2d}: n={idx.sum():4d}  logloss={ll_m:.4f}  brier={br_m:.4f}  (prior-only logloss={ll_b:.4f})")

    # ---------- Calibration buckets ----------
    print("\ncalibration (deciles):")
    bins = np.linspace(0, 1, 11)
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (cv_pred >= lo) & (cv_pred < hi if hi < 1.0 else cv_pred <= hi)
        if m.sum() == 0: continue
        print(f"  [{lo:.1f}, {hi:.1f})  n={m.sum():4d}  pred={cv_pred[m].mean():.3f}  actual={y[m].mean():.3f}")

    # ---------- Time-based holdout (last 20% of games) ----------
    games_sorted = frames.groupby("gameid")["date"].first().sort_values()
    n_test = max(1, int(0.2 * len(games_sorted)))
    test_games = set(games_sorted.tail(n_test).index)
    is_test = frames["gameid"].isin(test_games).values
    if is_test.sum() > 0 and (~is_test).sum() > 0:
        scaler_h = StandardScaler().fit(X[~is_test])
        clf_h = LogisticRegression(C=1.0, max_iter=1000)
        clf_h.fit(scaler_h.transform(X[~is_test]), y[~is_test])
        p_h = clf_h.predict_proba(scaler_h.transform(X[is_test]))[:, 1]
        ll_h = log_loss(y[is_test], p_h, labels=[0, 1])
        br_h = brier_score_loss(y[is_test], p_h)
        ll_h_base = log_loss(y[is_test], base_p[is_test], labels=[0, 1])
        print(f"\ntime-holdout (last {n_test} games, {is_test.sum()} frames):"
              f"  logloss={ll_h:.4f}  brier={br_h:.4f}  (prior-only logloss={ll_h_base:.4f})")

    # ---------- Fit final model on all data ----------
    final_scaler = StandardScaler().fit(X)
    final_clf = LogisticRegression(C=1.0, max_iter=1000).fit(final_scaler.transform(X), y)

    coefs = dict(zip(feat_names, final_clf.coef_[0]))
    print("\nfinal-model standardized coefs:")
    for k, v in coefs.items():
        print(f"  {k:14s} {v:+.4f}")

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with MODEL_PATH.open("wb") as f:
        pickle.dump({"scaler": final_scaler, "clf": final_clf, "features": feat_names}, f)

    META_PATH.write_text(json.dumps({
        "n_frames":            int(len(frames)),
        "n_games":             int(frames["gameid"].nunique()),
        "leagues":             sorted(frames["league"].unique().tolist()),
        "cv_logloss":          float(overall_ll),
        "cv_brier":            float(overall_br),
        "baseline_logloss":    float(base_ll),
        "baseline_brier":      float(base_br),
        "logloss_lift":        float(base_ll - overall_ll),
        "fold_metrics":        fold_metrics,
        "standardized_coefs":  {k: float(v) for k, v in coefs.items()},
        "intercept":           float(final_clf.intercept_[0]),
    }, indent=2))

    print(f"\nwrote model → {MODEL_PATH}")
    print(f"wrote meta  → {META_PATH}")


if __name__ == "__main__":
    main()
