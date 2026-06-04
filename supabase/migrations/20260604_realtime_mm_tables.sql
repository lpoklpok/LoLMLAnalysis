-- Enable Supabase Realtime on MM tables so the cockpit pages can subscribe
-- instead of polling every 2 seconds. Cuts egress by ~30x on those routes.
--
-- Idempotent — re-running these is a no-op once the tables are in the
-- publication.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mm_config'
  ) then
    alter publication supabase_realtime add table public.mm_config;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mm_state'
  ) then
    alter publication supabase_realtime add table public.mm_state;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mm_kill_switch'
  ) then
    alter publication supabase_realtime add table public.mm_kill_switch;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kalshi_mm_state'
  ) then
    alter publication supabase_realtime add table public.kalshi_mm_state;
  end if;
end $$;

-- Realtime needs REPLICA IDENTITY for UPDATE/DELETE payloads to include
-- the old row. Tables with a primary key already have DEFAULT replica
-- identity (the PK), which suffices for our cockpit patches because we
-- key off PK / (condition_id, outcome_index, side). If a table doesn't
-- have a PK, set REPLICA IDENTITY FULL — but all four of these do.
