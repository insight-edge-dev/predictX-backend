-- IPL Historical Data Schema
-- Run this in Supabase SQL editor before running process_ipl.py

-- Head to head records (team1/team2 are alphabetically sorted shortcodes)
create table if not exists ipl_h2h (
  team1       text not null,
  team2       text not null,
  matches     int  default 0,
  team1_wins  int  default 0,
  team2_wins  int  default 0,
  no_result   int  default 0,
  primary key (team1, team2)
);

-- Each team's record at each venue
create table if not exists ipl_venue_stats (
  venue   text not null,
  team    text not null,
  matches int  default 0,
  wins    int  default 0,
  primary key (venue, team)
);

-- Overall venue characteristics
create table if not exists ipl_venue_overall (
  venue                    text    not null primary key,
  matches                  int     default 0,
  bat_first_wins           int     default 0,
  chase_wins               int     default 0,
  no_results               int     default 0,
  avg_first_innings_score  numeric default 0,
  toss_winner_match_wins   int     default 0
);

-- Team performance per calendar year
create table if not exists ipl_team_season (
  team       text not null,
  season     int  not null,
  matches    int  default 0,
  wins       int  default 0,
  losses     int  default 0,
  no_results int  default 0,
  primary key (team, season)
);

-- Career batting stats per player
create table if not exists ipl_player_batting (
  player      text    not null primary key,
  innings     int     default 0,
  runs        int     default 0,
  balls       int     default 0,
  fours       int     default 0,
  sixes       int     default 0,
  dismissals  int     default 0,
  average     numeric default 0,
  strike_rate numeric default 0,
  fifties     int     default 0,
  hundreds    int     default 0
);

-- Career bowling stats per player
create table if not exists ipl_player_bowling (
  player      text    not null primary key,
  innings     int     default 0,
  balls       int     default 0,
  runs        int     default 0,
  wickets     int     default 0,
  economy     numeric default 0,
  average     numeric default 0,
  strike_rate numeric default 0
);

-- Player stats against a specific team (batter vs bowling_team / bowler vs batting_team)
create table if not exists ipl_player_vs_team (
  player             text not null,
  vs_team            text not null,
  batter_runs        int  default 0,
  batter_balls       int  default 0,
  batter_dismissals  int  default 0,
  bowler_wickets     int  default 0,
  bowler_runs        int  default 0,
  bowler_balls       int  default 0,
  primary key (player, vs_team)
);

-- Team batting strength per season (avg score, strike rate)
create table if not exists ipl_team_batting (
  team          text    not null,
  season        int     not null,
  innings       int     default 0,
  total_runs    int     default 0,
  avg_score     numeric default 0,
  avg_sr        numeric default 0,
  primary key (team, season)
);

-- Team bowling strength per season (economy, wickets per match)
create table if not exists ipl_team_bowling (
  team              text    not null,
  season            int     not null,
  innings           int     default 0,
  total_balls       int     default 0,
  total_runs        int     default 0,
  total_wickets     int     default 0,
  economy           numeric default 0,
  wickets_per_match numeric default 0,
  primary key (team, season)
);
