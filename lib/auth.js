import { supabase } from "./supabaseClient";

/* ---------------------------------------------------------
   Real authentication for MathsUnlocked BN.

   Students still log in with just a name + 6-digit PIN. Under
   the hood that maps to a genuine Supabase Auth account:

     email    = "<name-slug>.<pin>@students.mathsunlockedbn.app"
     password = a value derived from name + PIN (NOT the PIN
                itself, so the address can't leak the password)

   The account gives every student a real auth.uid(), which the
   Row Level Security policies on kv_store key every row to — so
   one student can no longer read or overwrite another's data,
   even with dev tools open.

   Email confirmation must be OFF in the Supabase dashboard
   (Authentication -> Providers -> Email) because these synthetic
   addresses can't receive mail.
--------------------------------------------------------- */

// The synthetic-email domain. Supabase's hosted signup validator does an
// MX-record lookup on this domain, so if account creation fails with
// "Email address ... is invalid" even after turning "Confirm email" OFF,
// set NEXT_PUBLIC_AUTH_EMAIL_DOMAIN to a domain that has MX records
// (any domain you control — the mail is never actually sent).
const AUTH_DOMAIN =
  (typeof process !== "undefined" && process.env && process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN) ||
  "students.mathsunlockedbn.app";

export const authSlug = (name) =>
  (name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "student";

const synthEmail = (name, pin) => `${authSlug(name)}.${pin}@${AUTH_DOMAIN}`;
// Deterministic from name + PIN so any device can rebuild it, but
// deliberately different from the email address.
const synthPassword = (name, pin) => `mu1:${authSlug(name)}:${pin}:unlock`;

const NET_ERR = "Can't reach the server. Check your internet connection and try again.";
const PIN_ERR = "That name and PIN don't match an account. Check your PIN, or choose a different name.";

/* Ensure the account exists. Preferred path is the student-auth Edge
   Function (service-role admin.createUser — bypasses the hosted email
   validator and the confirm-email requirement). If that function isn't
   deployed we fall back to a plain signUp. Returns { created }. */
async function ensureAccount(name, pin, email, password) {
  try {
    const { data, error } = await supabase.functions.invoke("student-auth", { body: { name, pin } });
    if (!error) return { created: !!(data && data.created) };
    // Non-2xx from the function: read its JSON body for the message.
    const status = error.context && typeof error.context.status === "number" ? error.context.status : 0;
    if (status && status !== 404) {
      let msg = "Could not sign in.";
      try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    // 404 / not deployed -> fall through to signUp
  } catch (e) {
    if (e instanceof Error && e.message && !/failed to fetch|networkerror|load failed/i.test(e.message)) {
      // A real error the function returned — surface it.
      if (e.message !== "Could not sign in.") throw e;
    }
    // otherwise: function unreachable or not deployed, try signUp
  }

  let upRes;
  try {
    upRes = await supabase.auth.signUp({ email, password, options: { data: { display_name: name } } });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  if (upRes.error) {
    const m = upRes.error.message || "";
    if (/already registered|already exists|user already/i.test(m)) throw new Error(PIN_ERR);
    if (/rate|too many/i.test(m)) throw new Error("Too many tries — wait a minute and try again.");
    if (/invalid/i.test(m) && /email/i.test(m)) {
      throw new Error("Sign-up isn't set up yet — deploy the student-auth Edge Function (see supabase/functions/student-auth).");
    }
    throw new Error(m || "Could not sign in. Check your connection and try again.");
  }
  return { created: true };
}

/* Sign in with name + PIN, creating the account the first time.
   Resolves to { user, created }. Throws Error with a friendly
   .message on a real problem (wrong PIN, network down). */
export async function signInOrRegister(name, pin) {
  const email = synthEmail(name, pin);
  const password = synthPassword(name, pin);

  // Fast path: a returning student already has an account.
  let inRes;
  try {
    inRes = await supabase.auth.signInWithPassword({ email, password });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  if (!inRes.error && inRes.data && inRes.data.user) {
    return { user: inRes.data.user, created: false };
  }

  // First login for this name+PIN: make the account, then sign in.
  const { created } = await ensureAccount(name, pin, email, password);

  let back;
  try {
    back = await supabase.auth.signInWithPassword({ email, password });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  if (back.error || !back.data || !back.data.user) {
    const m = (back.error && back.error.message) || "";
    if (/not confirmed/i.test(m)) {
      throw new Error("This account was made before email confirmation was turned off. Delete it in Supabase (Authentication -> Users) and register again.");
    }
    throw new Error(PIN_ERR);
  }
  return { user: back.data.user, created };
}

export async function currentUser() {
  try {
    const { data } = await supabase.auth.getSession();
    return (data && data.session && data.session.user) || null;
  } catch (e) {
    return null;
  }
}

export async function currentUid() {
  const u = await currentUser();
  return u ? u.id : null;
}

export async function signOut() {
  try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
}

/* Leaderboard / friends / admin: a SECURITY DEFINER function returns
   every student's public profile (full record minus pin + parentToken),
   which RLS would otherwise hide. Returns an array; [] on failure. */
export async function getLeaderboard() {
  try {
    const { data, error } = await supabase.rpc("get_leaderboard");
    if (error) return [];
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

/* Parent link: resolve ?p=<token> to one sanitised profile. */
export async function getParentView(tok) {
  try {
    const { data, error } = await supabase.rpc("get_parent_view", { tok });
    if (error) return null;
    return data || null;
  } catch (e) {
    return null;
  }
}
