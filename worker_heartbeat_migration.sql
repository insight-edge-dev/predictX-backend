-- worker_heartbeat_migration.sql
-- Run once in Supabase SQL Editor → New Query → Run
--
-- Stores a single-row liveness record that worker.js updates every 60 s.
-- /api/health reads this to report "Worker: alive 30s ago" vs "Worker: dead 2h ago".

create table if not exists worker_heartbeat (
  id          int          primary key default 1,
  last_seen   timestamptz  not null    default now(),
  worker_pid  int,
  constraint single_row check (id = 1)
);

-- Seed the initial row so the first SELECT always finds something
insert into worker_heartbeat (id, last_seen)
  values (1, now())
  on conflict (id) do nothing;
