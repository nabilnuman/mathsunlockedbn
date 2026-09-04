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

-- --- shared question banks: any signed-in user reads, only teachers write ---
drop policy if exists kv_shared_read on kv_store;
create policy kv_shared_read on kv_store for select to authenticated
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
revoke all on function public.get_leaderboard() from anon;
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
--  5b. NAME+PIN LOGIN AFTER A RECOVERY EMAIL IS ADDED
--     When a student attaches a recovery email, the account's
--     email changes away from the synthetic one, so name+PIN can
--     no longer guess it. We stash a hash of "<slug>.<pin>::mub"
--     in user_metadata; this maps it back to the current email.
--     Input is a hash of something the caller already knows (the
--     name + PIN), so it reveals nothing new.
-- ============================================================
create or replace function public.resolve_pin_login(h text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email
  from auth.users
  where raw_user_meta_data ->> 'pin_login_hash' = h
  limit 1
$$;
revoke all on function public.resolve_pin_login(text) from public;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- ============================================================
--  6. ACCOUNT CREATION  (not SQL)
--     Hosted Supabase blocks signUp() for our synthetic
--     name.pin@students.mathsunlockedbn.app addresses (MX check +
--     confirm-email). Deploy the Edge Function that creates the
--     accounts with the admin API instead:
--
--       see  supabase/functions/student-auth/README.md
--
--     (Dashboard -> Edge Functions -> new function "student-auth",
--      paste index.ts, turn OFF "Verify JWT", deploy.)
--
--     Authentication -> Email provider: just leave it enabled.
--     Confirm-email can stay on or off — the function marks each
--     account confirmed regardless.
-- ============================================================


-- ============================================================
--  7. CLEAN UP PROTOTYPE DATA   *** DELETES ROWS — READ FIRST ***
--
--  The pre-auth prototype scoped data two ways this build no
--  longer uses, and both are now readable by people they
--  shouldn't be:
--    * scope = 'private:<random-browser-id>'  — orphaned; nobody
--      can ever sign into these, but their key='profile' rows
--      still show as ghosts on the leaderboard.
--    * scope = 'shared', key 'student_*' / 'parent_*' — full
--      profile copies INCLUDING the PIN, world-readable.
--
--  Preview what would go (safe, read-only):
--
--    select scope, key, length(value) from kv_store
--    where scope like 'private:%'
--       or (scope = 'shared' and (key like 'student\_%' escape '\'
--                              or key like 'parent\_%'  escape '\'));
--
--  Then delete it (only run once you're happy with the preview —
--  you said the accounts are all test data):
--
--    delete from kv_store where scope like 'private:%';
--
--    delete from kv_store
--    where scope = 'shared'
--      and (key like 'student\_%' escape '\' or key like 'parent\_%' escape '\');
--
--  This keeps: every new scope = '<auth-uid>' row, and the
--  question banks (scope = 'shared', key 'questions_*').
-- ============================================================


-- ============================================================
--  8. FRIENDS
--     a = the student who sent the request, b = the target.
--     RLS: either party can read or delete a row; only the
--     requester can insert; only the target can flip it to
--     'accepted'. No SECURITY DEFINER needed.
-- ============================================================
create table if not exists friendships (
  a uuid not null,
  b uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (a, b)
);
alter table friendships enable row level security;

drop policy if exists fr_select on friendships;
create policy fr_select on friendships for select to authenticated
  using (a = auth.uid() or b = auth.uid());

drop policy if exists fr_insert on friendships;
create policy fr_insert on friendships for insert to authenticated
  with check (a = auth.uid() and status = 'pending');

drop policy if exists fr_accept on friendships;
create policy fr_accept on friendships for update to authenticated
  using (b = auth.uid()) with check (b = auth.uid());

drop policy if exists fr_delete on friendships;
create policy fr_delete on friendships for delete to authenticated
  using (a = auth.uid() or b = auth.uid());
