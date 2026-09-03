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

  // Fast path: a returning student whose account still has the synthetic email.
  let inRes;
  try {
    inRes = await supabase.auth.signInWithPassword({ email, password });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  if (!inRes.error && inRes.data && inRes.data.user) {
    return { user: inRes.data.user, created: false };
  }

  // Account may have swapped to a recovery email — look it up by the
  // stored login tag and sign in with that address (same password).
  const resolved = await resolveEmailForPin(name, pin);
  if (resolved && resolved.toLowerCase() !== email.toLowerCase()) {
    const alt = await supabase.auth.signInWithPassword({ email: resolved, password });
    if (!alt.error && alt.data && alt.data.user) {
      return { user: alt.data.user, created: false };
    }
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

/* ---- optional email recovery ----------------------------------------
   Name + PIN stays the only login. A student can additionally attach a
   real email; if they forget their PIN, that email gets a reset link ->
   they choose a NEW PIN. The account password is always derived from the
   current PIN, so there is no separate "email password".

   How name+PIN still finds the account after the email changes:
   `pinLoginTag` (a hash of slug + PIN) is stored in user_metadata, and
   the `resolve_pin_login` SQL function maps it back to the current email. */

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const pinLoginTag = (name, pin) => sha256Hex(`${authSlug(name)}.${pin}::mub`);

async function resolveEmailForPin(name, pin) {
  try {
    const { data, error } = await supabase.rpc("resolve_pin_login", { h: await pinLoginTag(name, pin) });
    if (error) return null;
    return data || null;
  } catch (e) {
    return null;
  }
}

/* Add (or change) the recovery email. Doesn't touch the password, so
   name + PIN keeps working. Supabase emails a confirmation link to the
   new address; the change lands when it's clicked. */
export async function addRecoveryEmail(name, pin, email) {
  const { error } = await supabase.auth.updateUser({
    email: email.trim(),
    data: { pin_login_hash: await pinLoginTag(name, pin), display_name: name },
  });
  if (error) {
    const m = error.message || "";
    if (/registered|exists/i.test(m)) throw new Error("That email is already used by another account.");
    if (/invalid/i.test(m) && /email/i.test(m)) throw new Error("That doesn't look like a valid email address.");
    if (/rate|too many/i.test(m)) throw new Error("Too many email requests just now — wait a few minutes.");
    throw new Error(m || "Couldn't save that. Try again.");
  }
}

export async function sendPinReset(email) {
  const redirectTo = typeof window !== "undefined" ? window.location.origin : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), redirectTo ? { redirectTo } : undefined);
  if (error) {
    if (/rate|too many/i.test(error.message || "")) throw new Error("Too many requests — wait a few minutes and try again.");
    throw new Error(error.message || "Couldn't send the email. Try again.");
  }
}

/* Finish a reset: the student (in a recovery session) picks a new PIN.
   Sets the password to the value derived from it and re-points the
   login tag, so name + <new PIN> works from here on. */
export async function completePinReset(name, newPin) {
  const { error } = await supabase.auth.updateUser({
    password: synthPassword(name, newPin),
    data: { pin_login_hash: await pinLoginTag(name, newPin), display_name: name },
  });
  if (error) throw new Error(error.message || "Couldn't set the new PIN.");
}

/* Fires cb() when the user arrives via a password-reset link. Returns an
   unsubscribe function. */
export function onPasswordRecovery(cb) {
  try {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") cb();
    });
    return () => { try { data.subscription.unsubscribe(); } catch (e) { /* ignore */ } };
  } catch (e) {
    return () => {};
  }
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
