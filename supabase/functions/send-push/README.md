# send-push — Web Push for MathsUnlockedBN

Delivers a browser notification to the other party of a real in-app event
(a Blitz challenge, a new homework assignment). Guarded so a signed-in
user can only trigger notifications tied to events they actually caused.

## One-time setup

### 1. Generate a VAPID key pair

```
npx web-push generate-vapid-keys
```

You get a **Public Key** and a **Private Key**.

### 2. Web app (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the **Public Key** |

Redeploy the site after adding it. Until this exists the in-app
"Notifications" toggle stays hidden.

### 3. Edge Function secrets (Dashboard → Edge Functions → Manage secrets, or `supabase secrets set NAME=value`)

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the **Public Key** (same as above) |
| `VAPID_PRIVATE_KEY` | the **Private Key** — keep secret |
| `VAPID_SUBJECT` | `mailto:nabilnuuman@gmail.com` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 4. Database

Run **§12** of `supabase/schema.sql` (creates `push_subscriptions`).

### 5. Deploy

```
supabase functions deploy send-push
```

Leave **Verify JWT ON** (the default) — callers must be signed in.

## Test

1. Open the app on your phone, ⚙ Settings → **Notifications** → allow.
2. From another account, send you a Blitz challenge, or (as a teacher) set
   homework for a class you're in. A notification should arrive within a
   few seconds.
3. Function logs: Dashboard → Edge Functions → send-push → Logs.

## Optional — daily "streak about to break" reminder

Not built yet. When you want it: add a `kind: "streak"` branch that a
scheduled job calls with the service-role key (pg_cron + `pg_net`, or a
scheduled Edge Function), scanning `kv_store` profiles for a live streak
with no activity today.
