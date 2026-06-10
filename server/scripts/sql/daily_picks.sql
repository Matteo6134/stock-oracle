-- Daily Picks Table
-- =================
-- Mirrors the in-process dailyPicks.json file. Each row is one pick (top-N
-- from a single end-of-day pass). Rows for the same pick_date + symbol are
-- upserted (so re-running the picker on the same day overwrites).
--
-- Run once via Supabase SQL Editor:
--   https://supabase.com/dashboard/project/eflmflhtkbzmvuaznxuv/sql/new

create table if not exists public.daily_picks (
  id              bigint generated always as identity primary key,
  pick_date       date         not null,
  symbol          text         not null,
  rank            int          not null default 1,        -- 1 = top pick of the day
  composite_score numeric      not null,
  expected_value  numeric,
  gem_score       int,
  claude_confidence int,
  explosion_prob  numeric,
  entry_price     numeric      not null,
  expected_return_pct numeric,
  reasoning       text,
  signals         text[],

  -- Order tracking (filled in by resolveAlpacaTrades after MOC settles)
  alpaca_buy_order_id  text,
  alpaca_sell_order_id text,
  dollar_allocated     numeric,

  -- Outcome (filled in by daily resolver cron after market close)
  outcome              text          check (outcome in ('win','loss','partial','pending') or outcome is null),
  fill_price_open      numeric,
  fill_price_close     numeric,
  realized_pnl         numeric,
  realized_pct         numeric,
  settled_at           timestamptz,

  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),

  unique (pick_date, symbol)
);

create index if not exists daily_picks_pick_date_idx on public.daily_picks (pick_date desc);
create index if not exists daily_picks_outcome_idx on public.daily_picks (outcome) where outcome is not null;
create index if not exists daily_picks_settled_idx on public.daily_picks (settled_at desc) where settled_at is not null;

-- RLS — allow anon to read/write (paper bot, no production secrets in here)
alter table public.daily_picks enable row level security;

drop policy if exists daily_picks_anon_select on public.daily_picks;
create policy daily_picks_anon_select on public.daily_picks for select using (true);

drop policy if exists daily_picks_anon_insert on public.daily_picks;
create policy daily_picks_anon_insert on public.daily_picks for insert with check (true);

drop policy if exists daily_picks_anon_update on public.daily_picks;
create policy daily_picks_anon_update on public.daily_picks for update using (true) with check (true);

-- updated_at auto-bump
create or replace function public.touch_daily_picks_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daily_picks_touch_updated_at on public.daily_picks;
create trigger daily_picks_touch_updated_at
  before update on public.daily_picks
  for each row execute function public.touch_daily_picks_updated_at();
