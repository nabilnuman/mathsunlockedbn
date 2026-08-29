-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run).

create table if not exists kv_store (
  scope text not null,
  key text not null,
  value text,
  updated_at timestamptz not null default now(),
  primary key (scope, key)
);

-- NOTE ON SECURITY:
-- Row Level Security is left OFF here so the app works immediately with
-- just the anon key, matching the prototype's behaviour (anyone can read
-- "shared" data — admin view, question bank — and write to their own
-- "private:<clientId>" scope, but nothing stops someone from guessing or
-- spoofing a clientId and reading/writing another visitor's private rows).
--
-- Before a real launch, turn RLS on and lock this down, e.g.:
--
--   alter table kv_store enable row level security;
--
--   create policy "anyone can read shared rows"
--     on kv_store for select
--     using (scope = 'shared');
--
--   create policy "anyone can write shared rows"
--     on kv_store for insert with check (scope = 'shared');
--   -- (tighten this once only admins should write shared data —
--   -- e.g. check auth.jwt() ->> 'role' = 'admin')
--
--   create policy "users manage their own private rows"
--     on kv_store for all
--     using (scope = 'private:' || auth.uid()::text)
--     with check (scope = 'private:' || auth.uid()::text);
--
-- That last policy assumes real Supabase Auth (auth.uid()) instead of the
-- localStorage-generated client id lib/storage.js uses today.
