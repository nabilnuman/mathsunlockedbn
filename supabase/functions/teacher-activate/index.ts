/* ------------------------------------------------------------------
   teacher-activate  —  Supabase Edge Function

   Redeems a teacher access code. The caller signs up as a normal
   student account first (login screen -> "Sign up as a teacher"),
   which behaves exactly like a student account until this function
   runs. Redeeming a valid code:

     - claims one use of the code (atomic)
     - inserts the caller into `teachers` (the teacher role)
     - inserts a `licenses` row, scope 'teacher', good for the
       code's `months` (stacks on top of any time still remaining)
     - marks their `teacher_applicants` row activated

   When that licence lapses the client drops the account back to
   student-only access; redeeming another code extends it.

   The caller must be signed in. supabase-js attaches the session
   token automatically when you invoke the function.

   Request  (POST, JSON):  { "code": "BRUNEI-PILOT-2026" }
   Response (JSON):        { "ok": true, "expires_at": "...", "months": 12 }
                     or:   { "error": "..." }   with a 4xx status

   Deploy:  supabase functions deploy teacher-activate
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
  const uid = caller.user.id;

  let body: { code?: unknown };
  try { body = await req.json(); } catch (_) { return json({ error: "Bad request." }, 400); }
  const code = (typeof body.code === "string" ? body.code : "").trim();
  if (!code) return json({ error: "Enter your access code." }, 400);

  // --- claim one use of the code (atomic) ---
  const { data: months, error: claimErr } = await admin.rpc("claim_teacher_code", { p_code: code });
  if (claimErr) return json({ error: "Couldn't check that code — try again." }, 500);
  if (months == null) {
    return json({ error: "That access code isn't valid, or it's already been fully used." }, 400);
  }

  try {
    // --- work out the new expiry (stack on any time still left) ---
    const { data: existing } = await admin
      .from("licenses")
      .select("expires_at")
      .eq("scope_type", "teacher")
      .eq("scope_value", uid)
      .order("expires_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const now = new Date();
    const base = existing && existing.expires_at && new Date(existing.expires_at) > now
      ? new Date(existing.expires_at)
      : now;
    const expiresAt = new Date(base);
    expiresAt.setMonth(expiresAt.getMonth() + Number(months));

    // --- name for the teachers row ---
    const meta = (caller.user.user_metadata || {}) as Record<string, unknown>;
    let name = typeof meta.display_name === "string" ? meta.display_name.trim() : "";
    if (!name) {
      const { data: appRow } = await admin
        .from("teacher_applicants").select("name").eq("uid", uid).maybeSingle();
      if (appRow && typeof appRow.name === "string") name = appRow.name.trim();
    }
    if (!name && caller.user.email && caller.user.email.endsWith("@" + DOMAIN)) {
      name = caller.user.email.split("@")[0].replace(/\.\d+$/, "");
    }
    if (!name) name = "Teacher";

    // --- grant the role + licence ---
    const { error: tErr } = await admin
      .from("teachers")
      .upsert({ uid, name }, { onConflict: "uid", ignoreDuplicates: true });
    if (tErr) throw tErr;

    const { error: lErr } = await admin.from("licenses").insert({
      scope_type: "teacher",
      scope_value: uid,
      plan: "premium",
      expires_at: expiresAt.toISOString(),
      note: "code:" + code,
    });
    if (lErr) throw lErr;

    // non-critical
    await admin.from("teacher_applicants").update({ activated: true }).eq("uid", uid);

    return json({ ok: true, expires_at: expiresAt.toISOString(), months: Number(months) });
  } catch (e) {
    // hand the use back so the code isn't silently burned
    try { await admin.rpc("release_teacher_code", { p_code: code }); } catch (_) { /* ignore */ }
    return json({ error: "Activation failed — please try again." }, 500);
  }
});
