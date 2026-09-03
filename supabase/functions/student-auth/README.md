# student-auth Edge Function

Creates a student's Supabase Auth account from **name + 6-digit PIN**.

The normal `supabase.auth.signUp()` can't do this because hosted Supabase:

- runs a **DNS/MX check** on the email domain (our synthetic
  `name.pin@students.mathsunlockedbn.app` addresses have no mail server), and
- enforces the project's **Confirm email** setting.

This function uses the **service-role** `admin.createUser({ email_confirm: true })`,
which skips both. The web app calls it once (first login for a name+PIN),
then signs in normally with `signInWithPassword`. If the function isn't
deployed, the app falls back to `signUp` (which only works if you *do*
have Confirm-email off and an MX-valid domain).

---

## Deploy — option A: Dashboard (no tools)

1. Supabase Dashboard → **Edge Functions** → **Deploy a new function**
   (or "Create function").
2. Name it exactly **`student-auth`**.
3. Paste the entire contents of [`index.ts`](./index.ts).
4. **Turn OFF "Verify JWT"** for this function (it's called before the
   student has a session). It's a toggle on the deploy screen, or under
   the function's **Details / Settings** after deploying.
5. Deploy.

No environment variables to set — `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## Deploy — option B: CLI

```bash
npx supabase login
npx supabase functions deploy student-auth \
  --project-ref ypumzxushtcdsucspjzg --no-verify-jwt
```

`supabase/config.toml` already sets `verify_jwt = false` for this function.

---

## Test it

```bash
curl -i -X POST \
  'https://ypumzxushtcdsucspjzg.supabase.co/functions/v1/student-auth' \
  -H 'Content-Type: application/json' \
  -H "apikey: <YOUR_ANON_KEY>" \
  -d '{"name":"Test Student","pin":"246813"}'
```

Expect `{"ok":true,"created":true}` the first time, `{"ok":true,"created":false}`
after. Then delete that test user in **Authentication → Users**.

## Custom domain (optional)

If you'd rather the synthetic addresses use a domain you own, set the
function secret `AUTH_EMAIL_DOMAIN` **and** the web app env var
`NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` to the same value.
