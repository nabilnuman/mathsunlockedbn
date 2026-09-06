/* ------------------------------------------------------------------
   send-push  —  Supabase Edge Function

   Delivers a Web Push notification to the OTHER party of a real
   in-app event, so a signed-in user can't use it to spam arbitrary
   people:

     { "kind": "blitz",    "id": "<blitz_challenges.id>" }
        -> notifies challenge.b, only if the caller is challenge.a

     { "kind": "homework", "id": "<assignments.id>" }
        -> notifies every student in the class, only if the caller
           is that class's teacher

   Response: { ok: true, sent, pruned }  or  { error } with a 4xx/5xx.

   Secrets to set (Dashboard -> Edge Functions -> Manage secrets, or
   `supabase secrets set`):
     VAPID_PUBLIC_KEY     (same value as NEXT_PUBLIC_VAPID_PUBLIC_KEY on Vercel)
     VAPID_PRIVATE_KEY
     VAPID_SUBJECT        e.g. mailto:nabilnuuman@gmail.com
   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

   Deploy:  supabase functions deploy send-push
   (Verify JWT: ON — the default. The caller must be signed in.)
------------------------------------------------------------------ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@mathsunlockedbn.app";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function displayName(admin: ReturnType<typeof createClient>, uid: string): Promise<string> {
  try {
    const { data } = await admin.from("kv_store").select("value").eq("scope", uid).eq("key", "profile").maybeSingle();
    if (data?.value) return JSON.parse(data.value).name || "A friend";
  } catch (_e) { /* ignore */ }
  return "A friend";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return json({ ok: true, sent: 0, skipped: "VAPID not configured" });
  }

  try {
    const { kind, id } = await req.json();
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const caller = (await createClient(URL, ANON).auth.getUser(jwt)).data.user?.id;
    if (!caller) return json({ error: "unauthorized" }, 401);

    const admin = createClient(URL, SERVICE);
    let targets: string[] = [];
    let payload: Record<string, unknown> | null = null;

    if (kind === "blitz") {
      const { data: ch } = await admin.from("blitz_challenges").select("a,b").eq("id", id).maybeSingle();
      if (!ch) return json({ error: "no such challenge" }, 404);
      if (ch.a !== caller) return json({ error: "not your challenge" }, 403);
      targets = [ch.b];
      payload = {
        title: "⚡ Blitz challenge",
        body: `${await displayName(admin, caller)} challenged you to a Blitz — beat their score!`,
        url: "/",
        tag: "blitz-" + id,
      };
    } else if (kind === "homework") {
      const { data: asg } = await admin.from("assignments").select("class_id,title,count").eq("id", id).maybeSingle();
      if (!asg) return json({ error: "no such assignment" }, 404);
      const { data: cls } = await admin.from("classes").select("teacher_uid,name").eq("id", asg.class_id).maybeSingle();
      if (!cls || cls.teacher_uid !== caller) return json({ error: "not your class" }, 403);
      const { data: members } = await admin.from("class_members").select("student_uid").eq("class_id", asg.class_id);
      targets = (members || []).map((m: { student_uid: string }) => m.student_uid).filter((u: string) => u !== caller);
      payload = {
        title: "📋 New homework",
        body: `${cls.name}: ${asg.title || `${asg.count} questions`}`,
        url: "/",
        tag: "hw-" + id,
      };
    } else {
      return json({ error: "unknown kind" }, 400);
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    let sent = 0, pruned = 0;
    for (const uid of targets) {
      const { data: subs } = await admin
        .from("push_subscriptions").select("endpoint,p256dh,auth").eq("uid", uid);
      for (const s of subs || []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
          );
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
            pruned++;
          }
        }
      }
    }
    return json({ ok: true, sent, pruned });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
