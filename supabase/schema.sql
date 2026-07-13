-- The Ledger — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Database > SQL Editor > New query).

-- A generic key/value store mirroring the app's existing storage calls
-- (items:<id>, journal:<id>, settings:goals, ui:viewMode, etc.) so the
-- app's logic didn't need to change — only the storage layer underneath it.
create table if not exists kv_store (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  shared boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create index if not exists kv_store_user_id_idx on kv_store(user_id);
create index if not exists kv_store_user_key_prefix_idx on kv_store(user_id, key text_pattern_ops);

-- Row Level Security: this is what actually protects each user's data —
-- without these policies, anyone with the anon key could read every row.
alter table kv_store enable row level security;

drop policy if exists "Users can view their own data" on kv_store;
create policy "Users can view their own data"
  on kv_store for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own data" on kv_store;
create policy "Users can insert their own data"
  on kv_store for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own data" on kv_store;
create policy "Users can update their own data"
  on kv_store for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own data" on kv_store;
create policy "Users can delete their own data"
  on kv_store for delete
  using (auth.uid() = user_id);

-- Keep updated_at current on every write (optional, handy for debugging).
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists kv_store_set_updated_at on kv_store;
create trigger kv_store_set_updated_at
  before update on kv_store
  for each row execute function set_updated_at();

-- ============================================================
-- Rate limiting for the "Look up" feature (/api/lookup).
-- Tracks how many lookups each user makes per day, so one account
-- can't run up your shared Anthropic API bill. Safe to run this
-- section even if you already ran the section above.
-- ============================================================
create table if not exists lookup_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table lookup_usage enable row level security;

drop policy if exists "Users can view their own usage" on lookup_usage;
create policy "Users can view their own usage"
  on lookup_usage for select
  using (auth.uid() = user_id);

-- No insert/update policy needed for regular users — all writes go
-- through the increment_lookup_usage() function below, which runs with
-- elevated privileges (security definer) but only ever touches the
-- calling user's own row, since it reads auth.uid() internally rather
-- than trusting a value passed in from outside.
create or replace function increment_lookup_usage(p_day date)
returns int
language plpgsql
security definer
as $$
declare
  new_count int;
begin
  insert into lookup_usage (user_id, day, count)
  values (auth.uid(), p_day, 1)
  on conflict (user_id, day) do update set count = lookup_usage.count + 1
  returning count into new_count;
  return new_count;
end;
$$;

