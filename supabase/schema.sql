-- Run this in your Supabase project's SQL Editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- Safe to run more than once: every statement is create-if-not-exists,
-- create-or-replace, or drop-policy-then-create. Nothing here deletes rows.

-- ============================================================
--  1. TABLE
-- ============================================================
create table if not exists kv_store (
  scope text not null,
  key text not null,
  value text,
  updated_at timestamptz not null default now(),
  primary key (scope, key)
);

-- ============================================================
--  2. TEACHER ALLOWLIST
--     After you first sign in to the app, find your auth uid in
--     Dashboard -> Authentication -> Users, then:
--       insert into teachers (uid) values ('<your-uid>');
--     Only uids in this table can edit the shared question bank.
-- ============================================================
create table if not exists teachers (uid uuid primary key);
alter table teachers enable row level security;
-- No policies on `teachers` => normal clients can't read or write it;
-- only the SECURITY DEFINER functions below and the service role can.

-- ============================================================
--  3. ROW LEVEL SECURITY on kv_store
-- ============================================================
alter table kv_store enable row level security;

-- --- a student's own private rows: scope holds their auth uid ---
drop policy if exists kv_own_select on kv_store;
create policy kv_own_select on kv_store for select to authenticated
  using (scope = auth.uid()::text);

drop policy if exists kv_own_insert on kv_store;
create policy kv_own_insert on kv_store for insert to authenticated
  with check (scope = auth.uid()::text);

drop policy if exists kv_own_update on kv_store;
create policy kv_own_update on kv_store for update to authenticated
  using (scope = auth.uid()::text) with check (scope = auth.uid()::text);

drop policy if exists kv_own_delete on kv_store;
create policy kv_own_delete on kv_store for delete to authenticated
  using (scope = auth.uid()::text);

-- --- shared question banks: everyone reads, only teachers write ---
drop policy if exists kv_shared_read on kv_store;
create policy kv_shared_read on kv_store for select to anon, authenticated
  using (scope = 'shared');

drop policy if exists kv_shared_write on kv_store;
create policy kv_shared_write on kv_store for all to authenticated
  using (scope = 'shared' and auth.uid() in (select uid from teachers))
  with check (scope = 'shared' and auth.uid() in (select uid from teachers));

-- ============================================================
--  4. LEADERBOARD / FRIENDS / ADMIN
--     RLS hides other students' rows from direct queries, so the
--     app reads them through this function instead. It returns
--     each profile as JSON with pin + parentToken stripped out,
--     plus the owner's uid so the app can mark "you".
-- ============================================================
create or replace function public.get_leaderboard()
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('uid', scope)
         || ((value::jsonb) - 'pin' - 'parentToken')
  from kv_store
  where key = 'profile'
    and value is not null
    and value <> ''
    and (value::jsonb) ? 'name'
    and coalesce((value::jsonb) ->> 'name', '') <> ''
$$;
revoke all on function public.get_leaderboard() from public;
grant execute on function public.get_leaderboard() to authenticated;

-- ============================================================
--  5. PARENT LINK
--     A parent isn't signed in, so ?p=<token> resolves through
--     this function: one profile matched by its share token,
--     again with the secrets stripped.
-- ============================================================
create or replace function public.get_parent_view(tok text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select (value::jsonb) - 'pin' - 'parentToken'
  from kv_store
  where key = 'profile'
    and value is not null
    and (value::jsonb) ->> 'parentToken' = tok
  limit 1
$$;
revoke all on function public.get_parent_view(text) from public;
grant execute on function public.get_parent_view(text) to anon, authenticated;

-- ============================================================
--  6. DASHBOARD SETTINGS (not SQL — do this in the UI)
--     Authentication -> Providers -> Email:
--       * Enable Email provider
--       * TURN OFF "Confirm email"  (synthetic addresses can't
--         receive mail; sign-up must return a session directly)
--     Authentication -> URL Configuration:
--       * Site URL = your deployed app URL (for password reset,
--         once the optional email-recovery flow ships)
-- ============================================================
