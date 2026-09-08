/* ------------------------------------------------------------------
   Daily reminder push — for students who don't open the app.

   Runs once a day from Vercel Cron (see vercel.json) at 22:00 UTC,
   which is 06:00 in Brunei (UTC+8) — deliberately in the morning so
   the "Daily Challenge is live" nudge never fires at midnight.

   It sends, per student, at most:
     • one "homework reminder"  — an assignment that isn't done and is
       due within 3 days (or overdue by up to 7)
     • one "Blitz challenge waiting" — an unanswered challenge from
       roughly the previous day
     • one "Daily Challenge is live" — only to students who have played
       the Daily Challenge at least once in the last 7 days and haven't
       played today (skipped if they already got a homework reminder)

   Web Push itself must be configured first (same VAPID keys as the
   send-push Edge Function). Environment variables on Vercel:
     CRON_SECRET                 any random string (Vercel sends it as
                                 "Authorization: Bearer <CRON_SECRET>")
     SUPABASE_SERVICE_ROLE_KEY   from Supabase → Project Settings → API
     VAPID_PUBLIC_KEY            = NEXT_PUBLIC_VAPID_PUBLIC_KEY
     VAPID_PRIVATE_KEY
     VAPID_SUBJECT               e.g. mailto:nabilnuuman@gmail.com
   NEXT_PUBLIC_SUPABASE_URL is already set.

   Until the env vars exist the route is a no-op (returns 503), so it's
   safe to deploy ahead of the push setup.
------------------------------------------------------------------ */

import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:nabilnuuman@gmail.com";

const DAY = 86400e3;
const HOUR = 3600e3;
// A calendar date string in Brunei time (UTC+8), offset by `deltaDays`.
const bruneiDate = (deltaDays = 0) =>
  new Date(Date.now() + 8 * HOUR + deltaDays * DAY).toISOString().slice(0, 10);

export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!SUPA_URL || !SERVICE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
    return Response.json({ ok: false, error: "push not configured yet" }, { status: 503 });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const sb = createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const now = Date.now();

  // ---- who can we reach? (endpoints grouped by student) ----------------
  const { data: subRows, error: subErr } = await sb
    .from("push_subscriptions")
    .select("endpoint,uid,p256dh,auth");
  if (subErr) return Response.json({ error: subErr.message }, { status: 500 });
  const subsByUid = new Map();
  for (const s of subRows || []) {
    if (!subsByUid.has(s.uid)) subsByUid.set(s.uid, []);
    subsByUid.get(s.uid).push(s);
  }
  if (subsByUid.size === 0) return Response.json({ ok: true, note: "no subscribers", sent: 0 });

  const { data: teacherRows } = await sb.from("teachers").select("uid");
  const teacherSet = new Set((teacherRows || []).map((t) => t.uid));

  // uid -> { title, body, url }, keyed by kind so we can cap per student
  const hwJob = new Map();
  const blitzJob = new Map();
  const dailyJob = new Map();

  // ---- 1. homework not done, due soon / overdue -----------------------
  {
    const { data: asg } = await sb
      .from("assignments")
      .select("id,class_id,title,count,due_at")
      .not("due_at", "is", null)
      .gte("due_at", new Date(now - 7 * DAY).toISOString())
      .lte("due_at", new Date(now + 3 * DAY).toISOString());
    if (asg && asg.length) {
      const classIds = [...new Set(asg.map((a) => a.class_id))];
      const { data: members } = await sb
        .from("class_members")
        .select("class_id,student_uid")
        .in("class_id", classIds);
      const studentsByClass = new Map();
      for (const m of members || []) {
        if (!subsByUid.has(m.student_uid)) continue; // only students we can reach
        if (!studentsByClass.has(m.class_id)) studentsByClass.set(m.class_id, []);
        studentsByClass.get(m.class_id).push(m.student_uid);
      }
      const studentUids = [...new Set([].concat(...studentsByClass.values()))];
      const profiles = await readProfiles(sb, studentUids);

      const pendingByUid = new Map(); // uid -> [assignment]
      for (const a of asg) {
        for (const uid of studentsByClass.get(a.class_id) || []) {
          const prof = profiles.get(uid);
          const rec = prof && prof.hw && prof.hw[a.id];
          const done = rec && typeof rec.best === "number";
          if (done) continue;
          if (!pendingByUid.has(uid)) pendingByUid.set(uid, []);
          pendingByUid.get(uid).push(a);
        }
      }
      for (const [uid, list] of pendingByUid) {
        const overdue = list.some((a) => new Date(a.due_at).getTime() < now);
        const body =
          list.length === 1
            ? `“${list[0].title || `${list[0].count} questions`}” is ${overdue ? "overdue" : "due soon"} — open the app to submit it.`
            : `You have ${list.length} assignments ${overdue ? "(some overdue)" : "due soon"} — open the app to catch up.`;
        hwJob.set(uid, { title: "Homework reminder", body, url: "/", tag: "hw-daily" });
      }
    }
  }

  // ---- 2. Blitz challenges still waiting for a reply ------------------
  {
    const { data: challenges } = await sb
      .from("blitz_challenges")
      .select("id,a,b,created_at")
      .is("score_b", null)
      .gte("created_at", new Date(now - 30 * HOUR).toISOString())
      .lte("created_at", new Date(now - 10 * HOUR).toISOString());
    if (challenges && challenges.length) {
      const names = await readProfileNames(sb, [...new Set(challenges.map((c) => c.a))]);
      for (const c of challenges) {
        if (!subsByUid.has(c.b)) continue;
        const who = names.get(c.a) || "A friend";
        blitzJob.set(c.b, {
          title: "Blitz challenge waiting",
          body: `${who} is waiting for your Blitz round — open the app and beat their score.`,
          url: "/",
          tag: "blitz-daily",
        });
      }
    }
  }

  // ---- 3. "Daily Challenge is live" (engaged players only) -----------
  {
    const { data: recent } = await sb
      .from("daily_results")
      .select("uid,day")
      .gte("day", bruneiDate(-7));
    const playedRecently = new Set();
    const playedToday = new Set();
    const today = bruneiDate(0);
    for (const r of recent || []) {
      playedRecently.add(r.uid);
      if (r.day === today) playedToday.add(r.uid);
    }
    for (const uid of subsByUid.keys()) {
      if (teacherSet.has(uid)) continue;
      if (!playedRecently.has(uid) || playedToday.has(uid)) continue;
      dailyJob.set(uid, {
        title: "Today's Daily Challenge is live",
        body: "One question, same for everyone. Set the time to beat.",
        url: "/",
        tag: "daily-live",
      });
    }
  }

  // ---- cap: homework + blitz always; daily only if no homework -------
  const outbox = []; // { uid, payload }
  for (const uid of subsByUid.keys()) {
    if (hwJob.has(uid)) outbox.push({ uid, payload: hwJob.get(uid) });
    if (blitzJob.has(uid)) outbox.push({ uid, payload: blitzJob.get(uid) });
    if (dailyJob.has(uid) && !hwJob.has(uid)) outbox.push({ uid, payload: dailyJob.get(uid) });
  }

  // ---- deliver ------------------------------------------------------
  const deliveries = [];
  for (const { uid, payload } of outbox) {
    for (const sub of subsByUid.get(uid) || []) deliveries.push({ sub, payload });
  }
  const dead = [];
  let sent = 0;
  const results = await Promise.allSettled(
    deliveries.map(({ sub, payload }) =>
      webpush
        .sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 12 * 3600 },
        )
        .then(() => { sent++; })
        .catch((err) => {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) dead.push(sub.endpoint);
        }),
    ),
  );
  void results;
  if (dead.length) {
    await sb.from("push_subscriptions").delete().in("endpoint", dead);
  }

  return Response.json({
    ok: true,
    homework: hwJob.size,
    blitz: blitzJob.size,
    daily: [...dailyJob.keys()].filter((u) => !hwJob.has(u)).length,
    notifications: outbox.length,
    sent,
    pruned: dead.length,
  });
}

// Read `hw` progress etc. from each student's stored profile (kv_store).
async function readProfiles(sb, uids) {
  const map = new Map();
  for (let i = 0; i < uids.length; i += 200) {
    const chunk = uids.slice(i, i + 200);
    if (!chunk.length) break;
    const { data } = await sb
      .from("kv_store")
      .select("scope,value")
      .eq("key", "profile")
      .in("scope", chunk);
    for (const row of data || []) {
      try { map.set(row.scope, JSON.parse(row.value)); } catch (e) { /* skip */ }
    }
  }
  return map;
}

async function readProfileNames(sb, uids) {
  const profiles = await readProfiles(sb, uids);
  const names = new Map();
  for (const [uid, p] of profiles) names.set(uid, (p && p.name) || null);
  return names;
}
