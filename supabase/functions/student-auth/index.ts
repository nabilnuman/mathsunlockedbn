/* ------------------------------------------------------------------
   student-auth  —  Supabase Edge Function

   Creates a student's account from name + 6-digit PIN using the
   service-role admin API. This exists because the hosted signup flow
   (supabase.auth.signUp) runs a DNS/MX check on the email domain and
   also enforces the project's "confirm email" setting — neither of
   which works for our synthetic addresses. admin.createUser with
   email_confirm:true skips both.

   The client calls this once (first login for a given name+PIN), then
   signs in normally with supabase.auth.signInWithPassword.

   Request  (POST, JSON):  { "name": "Amirah", "pin": "402519" }
   Response (JSON):        { "ok": true, "created": true|false }
                     or:   { "error": "..." }   with a 4xx/5xx status

   No secrets to configure — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
   are injected automatically. Set AUTH_EMAIL_DOMAIN only if you also
   set NEXT_PUBLIC_AUTH_EMAIL_DOMAIN on the web app; the two must match.

   Deploy:  supabase functions deploy student-auth --no-verify-jwt
   (or paste this file into Dashboard -> Edge Functions -> new function)
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
const emailFor = (name: string, pin: string) => `${slug(name)}.${pin}@${DOMAIN}`;
const passwordFor = (name: string, pin: string) => `mu1:${slug(name)}:${pin}:unlock`;

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let name = "", pin = "";
  try {
    const b = await req.json();
    name = typeof b.name === "string" ? b.name : "";
    pin = typeof b.pin === "string" ? b.pin : "";
  } catch (_) {
    return json({ error: "Bad request." }, 400);
  }
  if (!name.trim()) return json({ error: "Enter your name." }, 400);
  if (!/^\d{6}$/.test(pin)) return json({ error: "Your PIN must be exactly 6 digits." }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { error } = await admin.auth.admin.createUser({
    email: emailFor(name, pin),
    password: passwordFor(name, pin),
    email_confirm: true,
    user_metadata: { display_name: name.trim() },
  });

  if (error) {
    const m = (error.message || "").toLowerCase();
    if (m.includes("already") && m.includes("registered")) return json({ ok: true, created: false });
    if (m.includes("already exists")) return json({ ok: true, created: false });
    return json({ error: error.message || "Could not create the account." }, 400);
  }
  return json({ ok: true, created: true });
});
