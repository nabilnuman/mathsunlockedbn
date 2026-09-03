# teacher-reset-pin Edge Function

Lets a teacher set a new 6-digit PIN for a student who forgot theirs — no
email, no domain, no cost.

## Who can call it

The caller must be **signed in** (any student account works as a login)
**and** their auth uid must be in the `teachers` table:

```sql
insert into teachers (uid) values ('<your-uid>');
```

Find your uid in Dashboard → Authentication → Users. This is the same
`teachers` table used to gate question-bank edits (schema.sql §2).

## Deploy

### Dashboard
1. Dashboard → **Edge Functions** → **Deploy a new function**
2. Name it exactly **`teacher-reset-pin`**
3. Paste [`index.ts`](./index.ts) into `index.ts` (delete any extra files)
4. Leave **"Verify JWT" ON** (the caller is always signed in)
5. Deploy

### CLI
```bash
npx supabase functions deploy teacher-reset-pin --project-ref ypumzxushtcdsucspjzg
```

## How it works

Sets the student's password to the value derived from `name + newPin` and
updates `pin_login_hash` in their user_metadata. The student then logs in
normally with their name + the new PIN (`resolve_pin_login` maps the hash
back to their account). Their email — synthetic or a recovery address — is
left alone.

## Use it

Teacher view (`?teacher=1`) → **Registered Students** → a student's card →
**Reset PIN** → type a new 6-digit PIN → **Set**. Tell the student the new
PIN in person.
