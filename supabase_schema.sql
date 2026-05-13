create table if not exists games (
  gameid               text primary key,
  league               text,
  year                 integer,
  split                text,
  playoffs             integer,
  date                 timestamptz,
  game                 integer,
  patch                text,
  gamelength           integer,

  blue_team_teamname   text,
  red_team_teamname    text,
  blue_team_result     integer,   -- 1 = blue won, 0 = red won

  blue_top_champion    text,
  blue_jng_champion    text,
  blue_mid_champion    text,
  blue_bot_champion    text,
  blue_sup_champion    text,
  red_top_champion     text,
  red_jng_champion     text,
  red_mid_champion     text,
  red_bot_champion     text,
  red_sup_champion     text,

  blue_team_kills      integer,
  red_team_kills       integer,
  blue_team_dragons    integer,
  red_team_dragons     integer,
  blue_team_barons     integer,
  red_team_barons      integer,
  blue_team_towers     integer,
  red_team_towers      integer,
  blue_team_firstblood integer,
  blue_team_golddiffat15 numeric,

  odd1_decimal         numeric,
  odd2_decimal         numeric,
  implied_prob1_vigfree numeric,
  implied_prob2_vigfree numeric,
  team1                text,
  team2                text,
  format               text,
  q_blue_win           numeric,
  score_match          boolean
);

-- Indexes for common filter patterns
create index if not exists idx_games_league  on games (league);
create index if not exists idx_games_year    on games (year);
create index if not exists idx_games_patch   on games (patch);
create index if not exists idx_games_date    on games (date);
