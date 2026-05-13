# LoL ML Analysis — Basic Website Takeaway

## What We Built
A public website that visualizes historical League of Legends esports data — blue/red side win rates, champion pick rates by position, and a player lookup page. Live on Vercel, backed by Supabase, built with Next.js.

---

## The Stack
| Layer | Tool | Why |
|---|---|---|
| Data processing | Python + pandas | Clean/merge raw CSVs |
| Database | Supabase (Postgres) | Free, has REST API built in |
| Frontend | Next.js + TypeScript | Industry standard, Vercel deploys it natively |
| Charts | Recharts | Simple React charting library |
| Hosting | Vercel | Free, auto-deploys from GitHub |

---

## Step 1: Data Pipeline

**What we did:**
- Downloaded Oracle's Elixir (OE) match data and OddsPortal betting odds
- Wrote `combine_data.py` to reshape OE's raw per-player rows into one row per game with blue/red team columns
- Wrote `merge_data.py` to join games with odds at the series level

**Hard problems:**
- **Different league formats**: LPL games share a gameid prefix so grouping was easy. LCK/LEC/LCS needed grouping by `(league, date, team pair)` — much messier
- **Team name mismatches**: OE calls a team "T1", OddsPortal calls them "T1" or "SKT T1" — built a `_NORM_MAP` normalization dictionary
- **Date offsets**: OE stores times in UTC/KST, OddsPortal uses local time, so games near midnight wouldn't match. Added a ±1 day fallback which pushed match rate from 82.4% → **83.2%**
- **BO3/BO5 odds back-calculation**: Odds are for the whole series, but we needed per-game win probability. Used `scipy.optimize.brentq` to numerically solve the series probability formula backwards
- **Blue team flips between games**: In a BO3, the blue side switches each game. Series-level odds assumed game 1's assignment, so games 2+ had the wrong `q_blue_win`. Fixed by recomputing per-game based on which team actually had blue side

**Result:** 1,540 out of 1,852 series matched (83.2%)

---

## Step 2: Supabase Setup

**What we did:**
- Created a `games` table in Supabase with ~40 columns
- Wrote `upload_to_supabase.py` to batch-upload the CSV in groups of 500 rows
- Created SQL RPC functions so the frontend could get aggregated stats server-side

**Errors along the way:**
- **`ValueError: nan is not JSON compliant`** — pandas NaN values can't be serialized to JSON. Fixed with a `_sanitize_record()` function that converts NaN/inf/pd.NA → None
- **`invalid input syntax for type integer: "0.0"`** — integer columns had NaN so pandas stored them as floats. Fixed by using pandas nullable `Int64` type
- **Dashboard showed only 1,000 games** — Supabase has a 1,000 row fetch limit. Fixed by moving all aggregation into Postgres RPC functions (`get_summary_stats`, `get_champion_stats`) so no raw rows are ever fetched
- **`syntax error at or near "position"`** — `position` is a reserved word in PostgreSQL. Renamed the return column to `pos`
- **Player names missing** — forgot to include `playername` in `combine_data.py`. Re-ran the whole pipeline and re-uploaded

---

## Step 3: Frontend

**What we did:**
- Built a Next.js app in the `web/` subdirectory
- Dashboard with league/year/patch filters, stats cards, side win rate bar chart, champion pick/win rate table by position
- Player lookup page with autocomplete search, summary cards, champion history table

**Errors along the way:**
- **Site couldn't reach database** — forgot to create the `.env.local` file with Supabase keys
- **Filters not working** — position state was in the wrong component; lifted it up to the parent page so filter changes triggered a data reload

---

## Step 4: Deployment

**What we did:**
- Pushed code to GitHub, connected repo to Vercel, configured environment variables

**Errors along the way:**
- **"No Python entrypoint found"** — Vercel kept detecting the Python files at the repo root instead of the Next.js app in `web/`. Fixed by setting Root Directory to `web` in Vercel settings AND adding a `vercel.json` inside `web/` declaring `"framework": "nextjs"`
- **Deploying from wrong branch** — was pushing to `dev` but Vercel was watching `main`. Merged and pushed to `main`
- **TypeScript build error** — Recharts `Tooltip` formatter had strict types; `value` could be `undefined` but we typed it as `number`. Fixed by removing explicit types and using a cast on `entry.payload`
- **Vim got in the way** — `git pull` opened vim for a merge commit message and caused confusion. Solution: press Escape, type `:wq`, Enter

---

## End Result
- **Data pipeline**: Python scripts that merge 2 data sources, engineer features, and upload to cloud DB
- **Database**: Supabase Postgres with server-side aggregation functions
- **Website**: Live, public, filterable dashboard with player lookup
- **Cost**: $0
