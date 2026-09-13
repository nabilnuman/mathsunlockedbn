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

-- `default now()` only fires on INSERT, so an upsert that updates an
-- existing row would leave updated_at frozen at creation time. This
-- trigger bumps it on every write, so class_roster()'s "last active"
-- is real. Safe to re-run.
create or replace function public.kv_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists kv_touch on kv_store;
create trigger kv_touch before insert or update on kv_store
  for each row execute function public.kv_touch_updated_at();

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
--
--     Teacher accounts are hidden by default (they don't belong on
--     the school or top-players boards) — both activated teachers
--     (in `teachers`) AND anyone who signed up as a teacher but
--     hasn't redeemed a code yet (profile.teacherSignup). Pass
--     include_teachers => true for the boards where they ARE allowed
--     (friends, Blitz, Daily); each row carries an `is_teacher` flag.
-- ============================================================
drop function if exists public.get_leaderboard();
create or replace function public.get_leaderboard(include_teachers boolean default false)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'uid', scope,
           'is_teacher', scope in (select uid::text from teachers)
                         or coalesce((value::jsonb ->> 'teacherSignup')::boolean, false))
         || ((value::jsonb) - 'pin' - 'parentToken')
  from kv_store
  where key = 'profile'
    and value is not null
    and value <> ''
    and (value::jsonb) ? 'name'
    and coalesce((value::jsonb) ->> 'name', '') <> ''
    and (include_teachers or (
          scope not in (select uid::text from teachers)
          and coalesce((value::jsonb ->> 'teacherSignup')::boolean, false) = false))
$$;
revoke all on function public.get_leaderboard(boolean) from public;
revoke all on function public.get_leaderboard(boolean) from anon;
grant execute on function public.get_leaderboard(boolean) to authenticated;

-- ============================================================
--  5. PARENT LINK
--     A parent isn't signed in, so ?p=<token> resolves through
--     this function: one profile matched by its share token,
--     again with the secrets stripped. Also embeds the student's
--     live homework list (from any class they belong to) since a
--     parent has no session to query `assignments`/`class_members`
--     directly — completion itself still reads from the profile's
--     own `hw` field, already included above.
-- ============================================================
create or replace function public.get_parent_view(tok text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select (jsonb_build_object('last_active', updated_at)
         || ((value::jsonb) - 'pin' - 'parentToken'))
         || jsonb_build_object('assignments', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', a.id,
                       'title', a.title,
                       'topic_id', a.topic_id,
                       'count', a.count,
                       'due_at', a.due_at
                     ) order by a.due_at nulls last, a.created_at)
              from assignments a
              join class_members cm on cm.class_id = a.class_id
              where cm.student_uid = kv_store.scope::uuid
                and not a.archived
            ), '[]'::jsonb))
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

-- ============================================================
--  9. BLITZ CHALLENGES  (async PvP)
--     a = the challenger, b = the opponent. `a` plays first, so
--     the shared question set and a's score are written on insert;
--     `b` later plays the same questions and writes score_b.
--     Higher score wins. Nothing realtime.
--     RLS: either party reads/deletes; only a can insert (as
--     themselves, before b has played); either party may update
--     (the client only ever writes its own score).
-- ============================================================
create extension if not exists pgcrypto;
create table if not exists blitz_challenges (
  id uuid primary key default gen_random_uuid(),
  a uuid not null,
  b uuid not null,
  questions jsonb not null,
  score_a integer,
  score_b integer,
  created_at timestamptz not null default now()
);
alter table blitz_challenges enable row level security;

drop policy if exists bc_select on blitz_challenges;
create policy bc_select on blitz_challenges for select to authenticated
  using (a = auth.uid() or b = auth.uid());

drop policy if exists bc_insert on blitz_challenges;
create policy bc_insert on blitz_challenges for insert to authenticated
  with check (a = auth.uid() and score_b is null);

drop policy if exists bc_update on blitz_challenges;
create policy bc_update on blitz_challenges for update to authenticated
  using (a = auth.uid() or b = auth.uid())
  with check (a = auth.uid() or b = auth.uid());

drop policy if exists bc_delete on blitz_challenges;
create policy bc_delete on blitz_challenges for delete to authenticated
  using (a = auth.uid() or b = auth.uid());

-- ============================================================
--  10. CLASSES, LICENSES & ASSIGNMENTS   (the B2B layer)
--
--  A teacher (uid in `teachers`) owns `classes`. Students join a
--  class with its `join_code`. A `licenses` row that covers a
--  student (by class, by school, or the teacher themselves) grants
--  the premium tier — computed server-side by my_entitlement().
--  Assignments are per-class homework targets; progress is tracked
--  in the student's own profile (topicAttempts / asgSeen) and read
--  back by the teacher through class_roster().
-- ============================================================

-- teachers: let a signed-in user read ONLY their own row (so the app
-- knows "am I a teacher"). Inserts stay manual / service-role.
alter table teachers add column if not exists name text;
-- admin = true unlocks the dev/cheat tools, Admin view, Question bank and
-- the weekly-graphic generator. Plain teachers (admin = false) get only
-- the class dashboard. Set by hand:  update teachers set admin = true where name = 'Nabil';
alter table teachers add column if not exists admin boolean not null default false;
drop policy if exists teachers_self on teachers;
create policy teachers_self on teachers for select to authenticated
  using (uid = auth.uid());

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  teacher_uid uuid not null,
  name text not null,
  school text,
  join_code text not null unique,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
alter table classes enable row level security;

-- Only the teacher reads a `classes` row directly. Students get their
-- class info from my_classes() (SECURITY DEFINER) instead — keeping this
-- policy free of a class_members subquery avoids RLS recursion between
-- the two tables.
drop policy if exists cls_select on classes;
create policy cls_select on classes for select to authenticated
  using (teacher_uid = auth.uid());

drop policy if exists cls_write on classes;
create policy cls_write on classes for all to authenticated
  using (teacher_uid = auth.uid() and auth.uid() in (select uid from teachers))
  with check (teacher_uid = auth.uid() and auth.uid() in (select uid from teachers));

create table if not exists class_members (
  class_id uuid not null references classes(id) on delete cascade,
  student_uid uuid not null,
  joined_at timestamptz not null default now(),
  primary key (class_id, student_uid)
);
alter table class_members enable row level security;

-- read: the student themselves, or the class's teacher
drop policy if exists cm_select on class_members;
create policy cm_select on class_members for select to authenticated
  using (student_uid = auth.uid()
         or auth.uid() = (select teacher_uid from classes where id = class_members.class_id));

-- leave: the student themselves, or the class's teacher removing them.
-- (insert is only via join_class() below — a SECURITY DEFINER function.)
drop policy if exists cm_delete on class_members;
create policy cm_delete on class_members for delete to authenticated
  using (student_uid = auth.uid()
         or auth.uid() = (select teacher_uid from classes where id = class_members.class_id));

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id) on delete cascade,
  topic_id text not null,
  title text,
  count integer not null default 10 check (count between 1 and 200),
  subs text[] not null default '{}',  -- subtopic keys; empty = whole topic ("General")
  due_at timestamptz,
  created_at timestamptz not null default now()
);
alter table assignments add column if not exists subs text[] not null default '{}';
alter table assignments add column if not exists archived boolean not null default false; -- teacher "mark complete" — hidden from students, kept for history
alter table assignments enable row level security;

drop policy if exists asg_select on assignments;
create policy asg_select on assignments for select to authenticated
  using (auth.uid() = (select teacher_uid from classes where id = assignments.class_id)
         or auth.uid() in (select student_uid from class_members where class_id = assignments.class_id));

drop policy if exists asg_write on assignments;
create policy asg_write on assignments for all to authenticated
  using (auth.uid() = (select teacher_uid from classes where id = assignments.class_id))
  with check (auth.uid() = (select teacher_uid from classes where id = assignments.class_id));

-- licenses: manage these by hand in the SQL editor / service role.
--   scope_type 'teacher' -> scope_value = the teacher's auth uid
--   scope_type 'class'   -> scope_value = a classes.id
--   scope_type 'school'  -> scope_value = a school name (matches a
--                           student's profile school OR a class's school)
-- Example:
--   insert into licenses (scope_type, scope_value, expires_at, note)
--   values ('school', 'Chung Hwa Middle School BSB', '2026-12-31', 'pilot');
create table if not exists licenses (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('teacher', 'class', 'school')),
  scope_value text not null,
  plan text not null default 'premium',
  expires_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
alter table licenses enable row level security;
-- no client policies: only my_entitlement() (SECURITY DEFINER) and the
-- service role touch this table.

-- ---- functions --------------------------------------------------------

-- Student joins a class by its code. Case-insensitive, ignores archived.
-- Idempotent (re-joining is a no-op). Returns the class summary or an error.
create or replace function public.join_class(code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c classes%rowtype;
  tname text;
begin
  select * into c from classes
   where lower(join_code) = lower(trim(code)) and not archived
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No class has that code.');
  end if;
  insert into class_members (class_id, student_uid)
  values (c.id, auth.uid())
  on conflict do nothing;
  select coalesce(t.name, '') into tname from teachers t where t.uid = c.teacher_uid;
  return jsonb_build_object('ok', true, 'class_id', c.id, 'name', c.name,
                            'school', c.school, 'teacher_name', tname);
end;
$$;
revoke all on function public.join_class(text) from public, anon;
grant execute on function public.join_class(text) to authenticated;

-- Classes the caller is a member of (student side).
create or replace function public.my_classes()
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'class_id', c.id, 'name', c.name, 'school', c.school,
           'teacher_name', coalesce(t.name, ''), 'joined_at', m.joined_at,
           'archived', c.archived)
  from class_members m
  join classes c on c.id = m.class_id
  left join teachers t on t.uid = c.teacher_uid
  where m.student_uid = auth.uid()
$$;
revoke all on function public.my_classes() from public, anon;
grant execute on function public.my_classes() to authenticated;

-- Full roster for one of the CALLER'S OWN classes: each member's
-- profile (pin + parentToken stripped) plus their uid and join date.
create or replace function public.class_roster(cid uuid)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('uid', m.student_uid, 'joined_at', m.joined_at,
                            'last_active', k.updated_at)
         || case when k.value is null or k.value = '' then '{}'::jsonb
                 else (k.value::jsonb) - 'pin' - 'parentToken' end
  from class_members m
  left join kv_store k on k.scope = m.student_uid::text and k.key = 'profile'
  where m.class_id = cid
    and cid in (select id from classes where teacher_uid = auth.uid())
$$;
revoke all on function public.class_roster(uuid) from public, anon;
grant execute on function public.class_roster(uuid) to authenticated;

-- Does the caller currently have the premium tier, and why?
create or replace function public.my_entitlement()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  my_school text;
  lic licenses%rowtype;
begin
  if me is null then
    return jsonb_build_object('premium', false);
  end if;
  if exists (select 1 from teachers where uid = me) then
    return jsonb_build_object('premium', true, 'source', 'teacher');
  end if;
  select (value::jsonb) ->> 'school' into my_school
  from kv_store where scope = me::text and key = 'profile' limit 1;

  for lic in
    select * from licenses
    where (expires_at is null or expires_at > now())
  loop
    if lic.scope_type = 'teacher' and lic.scope_value = me::text then
      return jsonb_build_object('premium', true, 'source', 'teacher-license',
                                'expires_at', lic.expires_at, 'note', lic.note);
    elsif lic.scope_type = 'class' and exists (
        select 1 from class_members
        where student_uid = me and class_id::text = lic.scope_value) then
      return jsonb_build_object('premium', true, 'source', 'class',
                                'expires_at', lic.expires_at, 'note', lic.note);
    elsif lic.scope_type = 'school' and (
        lic.scope_value = my_school
        or exists (
          select 1 from class_members m join classes c on c.id = m.class_id
          where m.student_uid = me and c.school = lic.scope_value)) then
      return jsonb_build_object('premium', true, 'source', 'school',
                                'expires_at', lic.expires_at, 'note', lic.note);
    end if;
  end loop;

  return jsonb_build_object('premium', false);
end;
$$;
revoke all on function public.my_entitlement() from public, anon;
grant execute on function public.my_entitlement() to authenticated;

-- For the teacher dashboard: is one of MY classes covered by an active
-- licence (class-scoped for it, or school-scoped matching its school)?
create or replace function public.class_licensed(cid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cschool text;
  lic licenses%rowtype;
begin
  if not exists (select 1 from classes where id = cid and teacher_uid = auth.uid()) then
    return jsonb_build_object('licensed', false);
  end if;
  select school into cschool from classes where id = cid;
  for lic in
    select * from licenses where (expires_at is null or expires_at > now())
  loop
    if (lic.scope_type = 'class' and lic.scope_value = cid::text)
       or (lic.scope_type = 'school' and cschool is not null and lic.scope_value = cschool)
       or (lic.scope_type = 'teacher' and lic.scope_value = auth.uid()::text) then
      return jsonb_build_object('licensed', true, 'expires_at', lic.expires_at,
                                'note', lic.note, 'scope', lic.scope_type);
    end if;
  end loop;
  return jsonb_build_object('licensed', false);
end;
$$;
revoke all on function public.class_licensed(uuid) from public, anon;
grant execute on function public.class_licensed(uuid) to authenticated;

-- ============================================================
--  11. BETA FEEDBACK
--     Any signed-in student can drop a note from ⚙ Settings.
--     They can read their own notes back; only ADMIN teachers
--     (teachers.admin = true) read everything through
--     recent_feedback(). No updates or deletes from the client.
-- ============================================================
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  student_uid uuid not null default auth.uid(),
  name text,
  message text not null,
  rating smallint check (rating between 1 and 5),
  context jsonb not null default '{}',   -- { screen, topic, question, version }
  created_at timestamptz not null default now()
);
alter table feedback enable row level security;

drop policy if exists fb_insert on feedback;
create policy fb_insert on feedback for insert to authenticated
  with check (student_uid = auth.uid() and length(message) between 1 and 4000);

drop policy if exists fb_own_select on feedback;
create policy fb_own_select on feedback for select to authenticated
  using (student_uid = auth.uid());

-- Feedback inbox: newest first, capped. ADMIN-only (returns nothing
-- for a non-admin caller).
create or replace function public.recent_feedback(lim int default 200)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'id', id, 'name', coalesce(name, ''), 'message', message,
           'rating', rating, 'context', context, 'created_at', created_at)
  from feedback
  where auth.uid() in (select uid from teachers where admin)
  order by created_at desc
  limit greatest(1, least(coalesce(lim, 200), 500))
$$;
revoke all on function public.recent_feedback(int) from public, anon;
grant execute on function public.recent_feedback(int) to authenticated;

-- ============================================================
--  12. WEB PUSH SUBSCRIPTIONS
--     One row per browser/device that opted in. The client writes
--     its own rows (RLS); the `send-push` Edge Function reads every
--     row with the service-role key and delivers via VAPID.
--     Deploy steps are in supabase/functions/send-push/README.md.
-- ============================================================
create table if not exists push_subscriptions (
  endpoint text primary key,
  uid uuid not null default auth.uid(),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

drop policy if exists ps_own on push_subscriptions;
create policy ps_own on push_subscriptions for all to authenticated
  using (uid = auth.uid()) with check (uid = auth.uid());
-- (no anon access; the sender uses the service-role key and bypasses RLS)

-- ============================================================
--  13. DAILY CHALLENGE
--     One question a day, the same for everyone (the client seeds
--     it from the Brunei calendar day). One result per player per
--     day; the time is final. `daily_board` ranks today fastest-
--     first (teachers included — the Daily board is one of the
--     boards they're allowed on).
-- ============================================================
create table if not exists daily_results (
  day date not null default ((now() at time zone 'Asia/Brunei')::date),
  uid uuid not null default auth.uid(),
  name text,
  seconds numeric not null check (seconds > 0 and seconds < 86400),
  created_at timestamptz not null default now(),
  primary key (day, uid)
);
alter table daily_results enable row level security;

-- insert your own row, for today only, once (PK blocks a second)
drop policy if exists dr_insert on daily_results;
create policy dr_insert on daily_results for insert to authenticated
  with check (uid = auth.uid()
              and day = (now() at time zone 'Asia/Brunei')::date
              and seconds > 0);

-- read your own rows directly; the board comes from daily_board()
drop policy if exists dr_own on daily_results;
create policy dr_own on daily_results for select to authenticated
  using (uid = auth.uid());

create or replace function public.daily_board(d date default null)
returns setof jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('uid', r.uid, 'name', coalesce(r.name, ''), 'seconds', r.seconds)
  from daily_results r
  where r.day = coalesce(d, (now() at time zone 'Asia/Brunei')::date)
  order by r.seconds asc, r.created_at asc
  limit 300
$$;
revoke all on function public.daily_board(date) from public, anon;
grant execute on function public.daily_board(date) to authenticated;

create or replace function public.my_daily()
returns numeric
language sql stable security definer set search_path = public
as $$
  select seconds from daily_results
  where uid = auth.uid() and day = (now() at time zone 'Asia/Brunei')::date
  limit 1
$$;
revoke all on function public.my_daily() from public, anon;
grant execute on function public.my_daily() to authenticated;

-- ============================================================
--  14. ADMIN ROSTER
--     The "Registered Students" table in the Admin view. Every
--     student's profile (pin + parentToken stripped) plus their
--     last-active time. Admins only (teachers.admin = true).
-- ============================================================
create or replace function public.admin_students()
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('uid', k.scope, 'last_active', k.updated_at)
         || ((k.value::jsonb) - 'pin' - 'parentToken')
  from kv_store k
  where k.key = 'profile'
    and k.value is not null and k.value <> ''
    and (k.value::jsonb) ? 'name'
    and coalesce((k.value::jsonb) ->> 'name', '') <> ''
    and auth.uid() in (select uid from teachers where admin)
  order by k.updated_at desc
$$;
revoke all on function public.admin_students() from public, anon;
grant execute on function public.admin_students() to authenticated;

-- ============================================================
--  15. TEACHER SIGN-UP & LICENCE ACTIVATION
--     Anyone can register a teacher account from the login screen,
--     but it behaves as a plain student account until an access
--     code is redeemed. The `teacher-activate` Edge Function
--     (service role, Verify JWT ON) validates the code, inserts the
--     `teachers` row and a `licenses` row good for the code's
--     `months`. When that licence lapses the account drops back to
--     student-only access until a new code is redeemed.
-- ============================================================

-- Access codes — minted here by hand / service role only.
--   insert into teacher_codes (code, months, max_uses, note)
--   values ('BRUNEI-PILOT-2026', 12, 20, 'Free pilot - 20 seats');
create table if not exists teacher_codes (
  code            text primary key,
  months          int not null default 12,
  max_uses        int not null default 1,
  uses            int not null default 0,
  code_expires_at timestamptz,        -- the code itself stops working after this (optional)
  note            text,
  created_at      timestamptz not null default now()
);
alter table teacher_codes enable row level security;
-- no client policies: only the teacher-activate Edge Function (service role) touches it.

-- A lead record: who has registered wanting a teacher account.
create table if not exists teacher_applicants (
  uid        uuid primary key default auth.uid(),
  name       text,
  school     text,
  email      text,
  activated  boolean not null default false,
  created_at timestamptz not null default now()
);
alter table teacher_applicants enable row level security;

drop policy if exists ta_self on teacher_applicants;
create policy ta_self on teacher_applicants for all to authenticated
  using (uid = auth.uid()) with check (uid = auth.uid());

-- The caller's teacher-licence status:
--   { active:false }                         -> not a teacher / lapsed
--   { active:true, source:'role' }            -> in `teachers`, no licence
--                                               row (hand-added / comp account)
--   { active:bool, expires_at, note }         -> has teacher licence row(s);
--                                               active iff the newest hasn't expired
-- So an activated teacher whose licence lapses drops to { active:false },
-- but existing hand-added teacher accounts keep working with no migration.
create or replace function public.my_teacher_license()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not exists (
      select 1 from licenses
      where scope_type = 'teacher' and scope_value = auth.uid()::text)
    then jsonb_build_object(
           'active', exists (select 1 from teachers where uid = auth.uid()),
           'source', 'role')
    else (
      select jsonb_build_object(
               'active', (l.expires_at is null or l.expires_at > now()),
               'expires_at', l.expires_at,
               'note', l.note)
      from licenses l
      where l.scope_type = 'teacher' and l.scope_value = auth.uid()::text
      order by l.expires_at desc nulls first
      limit 1)
  end;
$$;
revoke all on function public.my_teacher_license() from public, anon;
grant execute on function public.my_teacher_license() to authenticated;

-- Atomically claim one use of an access code. service_role only (the
-- teacher-activate Edge Function). Returns the granted months, or NULL
-- when the code is unknown / exhausted / expired.
create or replace function public.claim_teacher_code(p_code text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare m int;
begin
  update teacher_codes
     set uses = uses + 1
   where code = p_code
     and uses < max_uses
     and (code_expires_at is null or code_expires_at > now())
  returning months into m;
  return m;
end;
$$;
revoke all on function public.claim_teacher_code(text) from public, anon, authenticated;
grant execute on function public.claim_teacher_code(text) to service_role;

-- Give back a use if activation fails after the claim. service_role only.
create or replace function public.release_teacher_code(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update teacher_codes set uses = greatest(uses - 1, 0) where code = p_code;
$$;
revoke all on function public.release_teacher_code(text) from public, anon, authenticated;
grant execute on function public.release_teacher_code(text) to service_role;

-- Admin: teacher sign-ups, newest first (teachers.admin = true only).
create or replace function public.recent_teacher_applicants(lim int default 100)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'uid', a.uid, 'name', a.name, 'school', a.school, 'email', a.email,
           'activated', a.activated, 'created_at', a.created_at,
           'is_teacher', a.uid in (select uid from teachers),
           'licensed', exists (
             select 1 from licenses l
             where l.scope_type = 'teacher' and l.scope_value = a.uid::text
               and (l.expires_at is null or l.expires_at > now())))
  from teacher_applicants a
  where auth.uid() in (select uid from teachers where admin)
  order by a.created_at desc
  limit lim
$$;
revoke all on function public.recent_teacher_applicants(int) from public, anon;
grant execute on function public.recent_teacher_applicants(int) to authenticated;

-- Admin: every teacher account (activated + still-pending sign-ups), for
-- the "Registered Teachers" tab in the Admin view. teachers.admin only.
--   status: 'licensed' (active licence) | 'lapsed' (had one, expired)
--         | 'active' (in `teachers`, no licence row — hand-added / comp)
--         | 'pending' (signed up, no code redeemed, not in `teachers`)
create or replace function public.admin_teachers()
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  with is_admin as (select 1 from teachers where uid = auth.uid() and admin)
  select jsonb_build_object(
           'uid', x.uid, 'name', x.name, 'admin', x.admin,
           'school', x.school, 'email', x.email,
           'signed_up_at', x.signed_up_at, 'last_active', x.last_active,
           'status', x.status, 'license_expires', x.license_expires,
           'classes', x.classes)
  from (
    select t.uid,
           coalesce(nullif(t.name, ''), a.name, '') as name,
           coalesce(t.admin, false) as admin,
           a.school, a.email, a.created_at as signed_up_at,
           k.updated_at as last_active,
           (select max(l.expires_at) from licenses l
              where l.scope_type = 'teacher' and l.scope_value = t.uid::text) as license_expires,
           case
             when exists (select 1 from licenses l where l.scope_type = 'teacher'
                          and l.scope_value = t.uid::text
                          and (l.expires_at is null or l.expires_at > now())) then 'licensed'
             when exists (select 1 from licenses l where l.scope_type = 'teacher'
                          and l.scope_value = t.uid::text) then 'lapsed'
             else 'active'
           end as status,
           (select count(*) from classes c where c.teacher_uid = t.uid) as classes
    from teachers t
    left join teacher_applicants a on a.uid = t.uid
    left join kv_store k on k.scope = t.uid::text and k.key = 'profile'
    union all
    select a.uid, coalesce(a.name, ''), false, a.school, a.email, a.created_at,
           k.updated_at, null::timestamptz, 'pending', 0
    from teacher_applicants a
    left join kv_store k on k.scope = a.uid::text and k.key = 'profile'
    where not exists (select 1 from teachers t where t.uid = a.uid)
  ) x
  where exists (select 1 from is_admin)
  order by x.signed_up_at desc nulls last
$$;
revoke all on function public.admin_teachers() from public, anon;
grant execute on function public.admin_teachers() to authenticated;

-- Parent link, fetched on demand for a teacher/admin viewing it on a
-- student's behalf (e.g. a parent lost the link). admin_students() and
-- class_roster() both deliberately strip parentToken from their bulk
-- payload (same treatment as pin), so this is the one targeted way to
-- read (or, if the student never opened their own Settings to generate
-- one, create) a single student's token.
--   Admin: any student.  Teacher: only a student currently in one of
--   their own classes.
create or replace function public.get_parent_link(target_uid uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  authorized boolean;
  prof jsonb;
  tok text;
begin
  select
    exists(select 1 from teachers where uid = auth.uid() and admin)
    or exists(
      select 1 from class_members m
      join classes c on c.id = m.class_id
      where m.student_uid = target_uid and c.teacher_uid = auth.uid()
    )
  into authorized;

  if not authorized then
    raise exception 'Not authorized';
  end if;

  select value::jsonb into prof from kv_store where scope = target_uid::text and key = 'profile';
  if prof is null then
    raise exception 'Student not found';
  end if;

  tok := prof ->> 'parentToken';
  if tok is null or tok = '' then
    tok := substr(replace(gen_random_uuid()::text, '-', ''), 1, 18); -- same shape as the client's genToken()
    update kv_store set value = (prof || jsonb_build_object('parentToken', tok))::text
      where scope = target_uid::text and key = 'profile';
  end if;

  return tok;
end;
$$;
revoke all on function public.get_parent_link(uuid) from public, anon;
grant execute on function public.get_parent_link(uuid) to authenticated;
