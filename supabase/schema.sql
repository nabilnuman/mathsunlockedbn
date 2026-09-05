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
  select jsonb_build_object('last_active', updated_at)
         || ((value::jsonb) - 'pin' - 'parentToken')
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
  due_at timestamptz,
  created_at timestamptz not null default now()
);
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
