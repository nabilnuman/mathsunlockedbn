/* ------------------------------------------------------------------
   teacher-reset-pin  —  Supabase Edge Function

   Lets a teacher set a new 6-digit PIN for a student who forgot theirs.
   No email involved.

   The caller must be signed in AND their uid must be in the `teachers`
   table (see supabase/schema.sql section 2). supabase-js attaches the
   caller's session token automatically when you invoke the function.

   Request  (POST, JSON):  { "uid": "<student auth uid>", "newPin": "728461" }
   Response (JSON):        { "ok": true, "name": "...", "newPin": "728461" }
                     or:   { "error": "..." }   with a 4xx status

   It sets the student's password to the value derived from
   name + newPin and updates the pin_login_hash in user_metadata, so
   the student then logs in normally with their name + the new PIN.
   Their email (synthetic or recovery) is left untouched.

   Deploy:  supabase functions deploy teacher-reset-pin
   (or paste this file into Dashboard -> Edge Functions -> new function;
    leave "Verify JWT" ON — the caller is always signed in.)
------------------------------------------------------------------ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DOMAIN = Deno.env.get("AUTH_EMAIL_DOMAIN") || "students.mathsunlockedbn.app";

const slug = (s: string) =>
  (s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "student";
const passwordFor = (name: string, pin: string) => `mu1:${slug(name)}:${pin}:unlock`;

async function pinLoginTag(name: string, pin: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${slug(name)}.${pin}::mub`));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Not signed in." }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: caller, error: cErr } = await admin.auth.getUser(token);
  if (cErr || !caller.user) return json({ error: "Not signed in." }, 401);

  const { data: teacher } = await admin.from("teachers").select("uid").eq("uid", caller.user.id).maybeSingle();
  if (!teacher) {
    return json({ error: "Only teachers can reset PINs. Ask the admin to add your account to the teachers list." }, 403);
  }

  let body: { uid?: unknown; newPin?: unknown };
  try { body = await req.json(); } catch (_) { return json({ error: "Bad request." }, 400); }
  const uid = typeof body.uid === "string" ? body.uid : "";
  const newPin = typeof body.newPin === "string" ? body.newPin : "";
  if (!uid) return json({ error: "Missing student." }, 400);
  if (!/^\d{6}$/.test(newPin)) return json({ error: "New PIN must be exactly 6 digits." }, 400);

  const { data: target, error: tErr } = await admin.auth.admin.getUserById(uid);
  if (tErr || !target.user) return json({ error: "That student wasn't found." }, 404);

  const meta = (target.user.user_metadata || {}) as Record<string, unknown>;
  let name = typeof meta.display_name === "string" ? meta.display_name : "";
  if (!name && target.user.email && target.user.email.endsWith("@" + DOMAIN)) {
    name = target.user.email.split("@")[0].replace(/\.\d+$/, "");
  }
  if (!name) return json({ error: "Couldn't determine that student's name — reset not possible." }, 422);

  const { error: uErr } = await admin.auth.admin.updateUserById(uid, {
    password: passwordFor(name, newPin),
    email_confirm: true,
    user_metadata: { ...meta, display_name: name, pin_login_hash: await pinLoginTag(name, newPin) },
  });
  if (uErr) return json({ error: uErr.message || "Couldn't reset the PIN." }, 400);

  return json({ ok: true, name, newPin });
});
