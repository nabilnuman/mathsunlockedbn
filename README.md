# MathsUnlockedBN

Next.js + Supabase port of the MathsUnlockedBN prototype. All the topics,
ranking logic, achievements, admin view, and question bank editor carried
over unchanged — the only real change is that progress is now saved to a
real database instead of in-artifact storage, so it works across devices
and survives closing the tab.

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com), create a free project.
2. In the Dashboard, go to **SQL Editor → New query**, paste the contents
   of `supabase/schema.sql`, and run it. This creates the one table the
   app needs (`kv_store`).
3. Go to **Project Settings → API**. You'll need the **Project URL** and
   the **anon public** key for the next step.

## 2. Run it locally (optional, but recommended before deploying)

```bash
npm install
cp .env.local.example .env.local
# edit .env.local and paste in your Supabase URL + anon key
npm run dev
```

Open http://localhost:3000 — you should see the login screen. Register a
student and click through a few questions to confirm it's actually
writing to Supabase (check **Table Editor → kv_store** in the Supabase
dashboard — you should see rows appear).

## 3. Deploy to Vercel

**Easiest path — from GitHub:**
1. Push this folder to a new GitHub repo.
2. Go to [vercel.com/new](https://vercel.com/new), import the repo.
3. Before clicking Deploy, expand **Environment Variables** and add:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (same values as your `.env.local`)
4. Click Deploy. You'll get a live `https://your-project.vercel.app` URL.

**Alternative — Vercel CLI, no GitHub needed:**
```bash
npm install -g vercel
vercel
# follow the prompts, then when it asks for env vars, add the two above
# (or add them afterwards in the Vercel dashboard → Settings → Environment Variables)
vercel --prod
```

## Teacher tools (Admin view + Question bank)

These are hidden from students by default. To unlock them in a browser,
visit the site once with `?teacher=1` on the URL, e.g.
`https://your-project.vercel.app/?teacher=1`. The unlock is remembered in
that browser's localStorage, so bookmark the plain URL afterwards. Visit
`?teacher=0` to hide them again. Share the plain URL (no query string)
with students.

This is a convenience gate, not a security boundary — it lives in the
browser, same as the client-ID model below. Anyone who knows the param
can flip it. Don't put anything in the admin view you'd mind a student
seeing.

## Known limitations (read before handing this to real students)

- **Not real authentication.** "Private" student data is scoped by a random
  ID stored in the browser's localStorage, not a login. It's enough to keep
  one student's progress separate from another's in normal use, but it is
  not secure — see the big comment in `lib/storage.js` for exactly what's
  missing and how to add real Supabase Auth later.
- **Row Level Security is off.** `supabase/schema.sql` explains why and
  gives the policies to turn on before a real launch.
- **The 30 question generators are still formulas, not a full question
  bank.** The Question Bank screen lets you layer hand-written questions
  on top of them, but replacing a generator's underlying formula still
  means editing `components/MathsUnlockedBN.jsx` directly.

These match exactly what's flagged in the project roadmap's Phase 1
milestone — this deploy is the skeleton, not the finished product.
