-- sync_jobs_migration.sql
-- Run this once in Supabase SQL Editor → New Query → Run
--
-- Records every background sync job run so you can answer:
--   "When did IPL last sync?"
--   "How many rows did the weekly historical sync write?"
--   "Did last night's scorecard backfill succeed?"
--
-- Query examples:
--   SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT 20;
--   SELECT * FROM sync_jobs WHERE status = 'failed';
--   SELECT job_name, MAX(finished_at), SUM(rows_written) FROM sync_jobs GROUP BY job_name;

create table if not exists sync_jobs (
  id           bigserial     primary key,
  job_name     text          not null,
  status       text          not null default 'running',  -- running | done | failed
  started_at   timestamptz   not null default now(),
  finished_at  timestamptz,
  duration_ms  int,
  rows_written int           not null default 0,
  error        text
);

-- Index for the /api/health endpoint (latest jobs, fast)
create index if not exists sync_jobs_started_at_idx on sync_jobs (started_at desc);

-- Index for filtering by job name (useful for per-job history)
create index if not exists sync_jobs_name_idx on sync_jobs (job_name, started_at desc);

-- Auto-prune: keep only the last 500 rows so the table never grows unbounded.
-- This trigger fires after every INSERT.
create or replace function prune_sync_jobs() returns trigger language plpgsql as $$
begin
  delete from sync_jobs
  where id in (
    select id from sync_jobs
    order by started_at desc
    offset 500
  );
  return null;
end;
$$;

drop trigger if exists trg_prune_sync_jobs on sync_jobs;
create trigger trg_prune_sync_jobs
  after insert on sync_jobs
  for each statement execute function prune_sync_jobs();
