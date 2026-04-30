"""
process_ipl.py — One-time script to process ipl.csv and populate Supabase.
Uses requests directly (no supabase Python client needed).

Run:
  cd backend/data
  python process_ipl.py
"""

import os, sys, json
import pandas as pd
import requests
from dotenv import load_dotenv

# ── Load env from backend/.env ────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in backend/.env")
    sys.exit(1)

CSV_PATH   = os.path.join(os.path.dirname(__file__), "ipl", "ipl.csv")
BATCH_SIZE = 400

HEADERS = {
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type":  "application/json",
    "Prefer":        "resolution=merge-duplicates,return=minimal",
}

# ── Upsert helper ─────────────────────────────────────────────

def upsert_all(table: str, records: list):
    if not records:
        print(f"  [!] {table}: 0 records -- skipping")
        return
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    total = len(records)
    for i in range(0, total, BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        resp  = requests.post(url, headers=HEADERS, data=json.dumps(batch))
        if resp.status_code not in (200, 201):
            print(f"  [FAIL] {table} batch {i//BATCH_SIZE+1}: {resp.status_code} {resp.text[:200]}")
            return
    print(f"  [OK] {table}: {total:,} records")

# ── Team normalization ────────────────────────────────────────

TEAM_MAP = {
    "Chennai Super Kings":          "CSK",
    "Mumbai Indians":               "MI",
    "Royal Challengers Bangalore":  "RCB",
    "Royal Challengers Bengaluru":  "RCB",
    "Kolkata Knight Riders":        "KKR",
    "Sunrisers Hyderabad":          "SRH",
    "Delhi Capitals":               "DC",
    "Delhi Daredevils":             "DC",
    "Rajasthan Royals":             "RR",
    "Punjab Kings":                 "PBKS",
    "Kings XI Punjab":              "PBKS",
    "Gujarat Titans":               "GT",
    "Lucknow Super Giants":         "LSG",
    "Deccan Chargers":              None,
    "Pune Warriors":                None,
    "Rising Pune Supergiant":       None,
    "Rising Pune Supergiants":      None,
    "Kochi Tuskers Kerala":         None,
}
CURRENT = {v for v in TEAM_MAP.values() if v}

def norm(name):
    return TEAM_MAP.get(str(name).strip())

# ── Load & prepare ────────────────────────────────────────────

print("Loading ipl.csv ...")
df = pd.read_csv(CSV_PATH, low_memory=False)
print(f"  {len(df):,} rows, {df['match_id'].nunique():,} raw matches")

# Regular innings only (no super overs)
df = df[df["innings"] <= 2].copy()

# Normalize teams
df["bat_team"]  = df["batting_team"].apply(norm)
df["bowl_team"] = df["bowling_team"].apply(norm)
df["won_by"]    = df["match_won_by"].apply(norm)
df["toss_win"]  = df["toss_winner"].apply(norm)

# Drop defunct team deliveries
df = df[df["bat_team"].notna() & df["bowl_team"].notna()].copy()

# Numeric coercions
for col in ["bowler_wicket", "valid_ball", "balls_faced", "runs_batter",
            "runs_bowler", "runs_total", "batter_runs"]:
    df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)

df["striker_out"] = df["striker_out"].astype(str).str.strip().str.lower() == "true"

print(f"  {len(df):,} rows after filter, {df['match_id'].nunique():,} matches kept")

# ── Derive matches_df ─────────────────────────────────────────

first_ball = (
    df[df["innings"] == 1]
    .sort_values(["match_id", "over", "ball"])
    .groupby("match_id")
    .first()
    .reset_index()
)

matches_df = first_ball[[
    "match_id", "date", "year", "venue", "city",
    "bat_team", "bowl_team", "won_by", "win_outcome",
    "toss_win", "toss_decision", "stage", "result_type",
]].rename(columns={"bat_team": "team1", "bowl_team": "team2"})

for col in ["win_outcome", "result_type", "stage", "toss_decision"]:
    matches_df[col] = matches_df[col].fillna("").astype(str)

matches_df["year"] = matches_df["year"].astype(int)

def is_no_result(rt):
    return "no result" in str(rt).lower()

print(f"  {len(matches_df):,} match records derived\n")

# ═══════════════════════════════════════════════════════════════
print("[1/8] Head-to-head ...")
# ═══════════════════════════════════════════════════════════════

h2h: dict = {}
for _, r in matches_df.iterrows():
    t1, t2, winner = r["team1"], r["team2"], r["won_by"]
    if not t1 or not t2:
        continue
    key = tuple(sorted([t1, t2]))
    if key not in h2h:
        h2h[key] = {"team1": key[0], "team2": key[1],
                    "matches": 0, "team1_wins": 0, "team2_wins": 0, "no_result": 0}
    h = h2h[key]
    h["matches"] += 1
    if is_no_result(r["result_type"]):
        h["no_result"] += 1
    elif winner == key[0]:
        h["team1_wins"] += 1
    elif winner == key[1]:
        h["team2_wins"] += 1
    else:
        h["no_result"] += 1

upsert_all("ipl_h2h", list(h2h.values()))

# ═══════════════════════════════════════════════════════════════
print("[2/8] Venue stats ...")
# ═══════════════════════════════════════════════════════════════

venue_overall: dict = {}
venue_team:    dict = {}

for _, r in matches_df.iterrows():
    venue   = str(r["venue"]).strip()
    t1, t2  = r["team1"], r["team2"]
    winner  = r["won_by"]
    toss_w  = r["toss_win"]
    out_str = r["win_outcome"].lower()
    nr      = is_no_result(r["result_type"])

    if not venue or not t1 or not t2:
        continue

    if venue not in venue_overall:
        venue_overall[venue] = {
            "venue": venue, "matches": 0,
            "bat_first_wins": 0, "chase_wins": 0, "no_results": 0,
            "avg_first_innings_score": 0.0, "toss_winner_match_wins": 0,
        }
    vo = venue_overall[venue]
    vo["matches"] += 1
    if nr:
        vo["no_results"] += 1
    elif "runs" in out_str:
        vo["bat_first_wins"] += 1
    elif "wicket" in out_str:
        vo["chase_wins"] += 1

    if winner and winner == toss_w:
        vo["toss_winner_match_wins"] += 1

    for team in [t1, t2]:
        k = (venue, team)
        if k not in venue_team:
            venue_team[k] = {"venue": venue, "team": team, "matches": 0, "wins": 0}
        venue_team[k]["matches"] += 1
        if winner == team:
            venue_team[k]["wins"] += 1

# Avg first innings score
inn1_totals = (
    df[df["innings"] == 1]
    .groupby(["match_id", "venue"])["runs_total"]
    .sum()
    .reset_index()
)
venue_avg = inn1_totals.groupby("venue")["runs_total"].mean().to_dict()
for venue, avg in venue_avg.items():
    if venue in venue_overall:
        venue_overall[venue]["avg_first_innings_score"] = round(float(avg), 1)

upsert_all("ipl_venue_overall", list(venue_overall.values()))
upsert_all("ipl_venue_stats",   list(venue_team.values()))

# ═══════════════════════════════════════════════════════════════
print("[3/8] Team season stats ...")
# ═══════════════════════════════════════════════════════════════

team_season: dict = {}
for _, r in matches_df.iterrows():
    year   = int(r["year"])
    winner = r["won_by"]
    nr     = is_no_result(r["result_type"])
    for team in [r["team1"], r["team2"]]:
        if not team:
            continue
        k = (team, year)
        if k not in team_season:
            team_season[k] = {"team": team, "season": year,
                              "matches": 0, "wins": 0, "losses": 0, "no_results": 0}
        ts = team_season[k]
        ts["matches"] += 1
        if nr:
            ts["no_results"] += 1
        elif winner == team:
            ts["wins"] += 1
        else:
            ts["losses"] += 1

upsert_all("ipl_team_season", list(team_season.values()))

# ═══════════════════════════════════════════════════════════════
print("[4/8] Player batting stats ...")
# ═══════════════════════════════════════════════════════════════

bat_agg = (
    df.groupby("batter")
    .agg(
        runs       = ("runs_batter", "sum"),
        balls      = ("balls_faced", "sum"),
        fours      = ("runs_batter", lambda x: int((x == 4).sum())),
        sixes      = ("runs_batter", lambda x: int((x == 6).sum())),
        dismissals = ("striker_out", "sum"),
    )
    .reset_index()
    .rename(columns={"batter": "player"})
)

inn_count = (
    df.groupby(["match_id", "innings", "batter"])
    .size().reset_index()[["match_id", "innings", "batter"]]
    .groupby("batter").size()
    .reset_index(name="innings")
    .rename(columns={"batter": "player"})
)
bat_agg = bat_agg.merge(inn_count, on="player", how="left")
bat_agg["innings"] = bat_agg["innings"].fillna(0).astype(int)

inn_max  = df.groupby(["match_id", "innings", "batter"])["batter_runs"].max().reset_index()
fifties  = (inn_max[inn_max["batter_runs"].between(50, 99)]
            .groupby("batter").size().reset_index(name="fifties")
            .rename(columns={"batter": "player"}))
hundreds = (inn_max[inn_max["batter_runs"] >= 100]
            .groupby("batter").size().reset_index(name="hundreds")
            .rename(columns={"batter": "player"}))

bat_agg = bat_agg.merge(fifties,  on="player", how="left")
bat_agg = bat_agg.merge(hundreds, on="player", how="left")
bat_agg[["fifties", "hundreds"]] = bat_agg[["fifties", "hundreds"]].fillna(0).astype(int)

bat_agg["average"] = bat_agg.apply(
    lambda r: round(r["runs"] / r["dismissals"], 2) if r["dismissals"] > 0 else float(r["runs"]), axis=1
)
bat_agg["strike_rate"] = bat_agg.apply(
    lambda r: round((r["runs"] / r["balls"]) * 100, 2) if r["balls"] > 0 else 0.0, axis=1
)

bat_agg = bat_agg[bat_agg["innings"] >= 5].copy()
for c in ["runs", "balls", "fours", "sixes", "dismissals", "innings", "fifties", "hundreds"]:
    bat_agg[c] = bat_agg[c].astype(int)

cols_bat = ["player", "innings", "runs", "balls", "fours", "sixes",
            "dismissals", "average", "strike_rate", "fifties", "hundreds"]
upsert_all("ipl_player_batting", bat_agg[cols_bat].to_dict(orient="records"))

# ═══════════════════════════════════════════════════════════════
print("[5/8] Player bowling stats ...")
# ═══════════════════════════════════════════════════════════════

bowl_agg = (
    df.groupby("bowler")
    .agg(
        balls   = ("valid_ball",    "sum"),
        runs    = ("runs_bowler",   "sum"),
        wickets = ("bowler_wicket", "sum"),
    )
    .reset_index()
    .rename(columns={"bowler": "player"})
)

bowl_inn = (
    df.groupby(["match_id", "innings", "bowler"])
    .size().reset_index()[["match_id", "innings", "bowler"]]
    .groupby("bowler").size()
    .reset_index(name="innings")
    .rename(columns={"bowler": "player"})
)
bowl_agg = bowl_agg.merge(bowl_inn, on="player", how="left")
bowl_agg["innings"] = bowl_agg["innings"].fillna(0).astype(int)

bowl_agg["economy"]     = bowl_agg.apply(
    lambda r: round(r["runs"] / (r["balls"] / 6), 2) if r["balls"] > 0 else 0.0, axis=1
)
bowl_agg["average"]     = bowl_agg.apply(
    lambda r: round(r["runs"] / r["wickets"], 2) if r["wickets"] > 0 else 0.0, axis=1
)
bowl_agg["strike_rate"] = bowl_agg.apply(
    lambda r: round(r["balls"] / r["wickets"], 2) if r["wickets"] > 0 else 0.0, axis=1
)

bowl_agg = bowl_agg[bowl_agg["innings"] >= 10].copy()
for c in ["balls", "runs", "wickets", "innings"]:
    bowl_agg[c] = bowl_agg[c].astype(int)

cols_bowl = ["player", "innings", "balls", "runs", "wickets", "economy", "average", "strike_rate"]
upsert_all("ipl_player_bowling", bowl_agg[cols_bowl].to_dict(orient="records"))

# ═══════════════════════════════════════════════════════════════
print("[6/8] Player vs team stats ...")
# ═══════════════════════════════════════════════════════════════

pvt_bat = (
    df.groupby(["batter", "bowl_team"])
    .agg(
        batter_runs       = ("runs_batter", "sum"),
        batter_balls      = ("balls_faced", "sum"),
        batter_dismissals = ("striker_out", "sum"),
    )
    .reset_index()
    .rename(columns={"batter": "player", "bowl_team": "vs_team"})
)

pvt_bowl = (
    df.groupby(["bowler", "bat_team"])
    .agg(
        bowler_wickets = ("bowler_wicket", "sum"),
        bowler_runs    = ("runs_bowler",   "sum"),
        bowler_balls   = ("valid_ball",    "sum"),
    )
    .reset_index()
    .rename(columns={"bowler": "player", "bat_team": "vs_team"})
)

pvt = pvt_bat.merge(pvt_bowl, on=["player", "vs_team"], how="outer").fillna(0)
pvt = pvt[pvt["vs_team"].isin(CURRENT)].copy()

int_pvt = ["batter_runs", "batter_balls", "batter_dismissals",
           "bowler_wickets", "bowler_runs", "bowler_balls"]
pvt[int_pvt] = pvt[int_pvt].astype(int)

pvt = pvt[(pvt["batter_balls"] >= 12) | (pvt["bowler_balls"] >= 12)].copy()

cols_pvt = ["player", "vs_team"] + int_pvt
upsert_all("ipl_player_vs_team", pvt[cols_pvt].to_dict(orient="records"))

# ═══════════════════════════════════════════════════════════════
print("[7/8] Team batting strength per season ...")
# ═══════════════════════════════════════════════════════════════

# Per match, per innings: total runs scored by batting team
inn_runs = (
    df.groupby(["match_id", "year", "innings", "bat_team"])
    .agg(
        total_runs = ("runs_batter", "sum"),
        total_balls = ("balls_faced", "sum"),
    )
    .reset_index()
)
inn_runs = inn_runs[inn_runs["bat_team"].notna()].copy()
inn_runs["year"] = inn_runs["year"].astype(int)

team_bat: dict = {}
for _, r in inn_runs.iterrows():
    team  = r["bat_team"]
    year  = int(r["year"])
    runs  = int(r["total_runs"])
    balls = int(r["total_balls"])
    if not team: continue
    k = (team, year)
    if k not in team_bat:
        team_bat[k] = {"team": team, "season": year,
                       "innings": 0, "total_runs": 0, "total_balls": 0}
    team_bat[k]["innings"]     += 1
    team_bat[k]["total_runs"]  += runs
    team_bat[k]["total_balls"] += balls

team_bat_records = []
for v in team_bat.values():
    inn  = v["innings"]
    runs = v["total_runs"]
    blls = v["total_balls"]
    team_bat_records.append({
        "team":       v["team"],
        "season":     v["season"],
        "innings":    inn,
        "total_runs": runs,
        "avg_score":  round(runs / inn, 2) if inn > 0 else 0.0,
        "avg_sr":     round((runs / blls) * 100, 2) if blls > 0 else 0.0,
    })

upsert_all("ipl_team_batting", team_bat_records)

# ═══════════════════════════════════════════════════════════════
print("[8/8] Team bowling strength per season ...")
# ═══════════════════════════════════════════════════════════════

# Per match, per innings: bowling team's economy and wickets
inn_bowl = (
    df.groupby(["match_id", "year", "innings", "bowl_team"])
    .agg(
        total_balls   = ("valid_ball",    "sum"),
        total_runs    = ("runs_bowler",   "sum"),
        total_wickets = ("bowler_wicket", "sum"),
    )
    .reset_index()
)
inn_bowl = inn_bowl[inn_bowl["bowl_team"].notna()].copy()
inn_bowl["year"] = inn_bowl["year"].astype(int)

team_bowl: dict = {}
for _, r in inn_bowl.iterrows():
    team    = r["bowl_team"]
    year    = int(r["year"])
    balls   = int(r["total_balls"])
    runs    = int(r["total_runs"])
    wickets = int(r["total_wickets"])
    if not team: continue
    k = (team, year)
    if k not in team_bowl:
        team_bowl[k] = {"team": team, "season": year,
                        "innings": 0, "total_balls": 0,
                        "total_runs": 0, "total_wickets": 0}
    team_bowl[k]["innings"]       += 1
    team_bowl[k]["total_balls"]   += balls
    team_bowl[k]["total_runs"]    += runs
    team_bowl[k]["total_wickets"] += wickets

team_bowl_records = []
for v in team_bowl.values():
    inn     = v["innings"]
    balls   = v["total_balls"]
    runs    = v["total_runs"]
    wickets = v["total_wickets"]
    team_bowl_records.append({
        "team":              v["team"],
        "season":            v["season"],
        "innings":           inn,
        "total_balls":       balls,
        "total_runs":        runs,
        "total_wickets":     wickets,
        "economy":           round(runs / (balls / 6), 2) if balls > 0 else 0.0,
        "wickets_per_match": round(wickets / inn, 2) if inn > 0 else 0.0,
    })

upsert_all("ipl_team_bowling", team_bowl_records)

# ── Done ──────────────────────────────────────────────────────
print("\n[DONE] Supabase populated with IPL 2008-2025 data (9 tables).")
