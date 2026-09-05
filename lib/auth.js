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

/* A signed-in student changes their own PIN. Sets the password to the
   value derived from name + newPin and re-points the login tag. */
export async function changePin(name, newPin) {
  if (!/^\d{6}$/.test(newPin || "")) throw new Error("PIN must be exactly 6 digits.");
  const { error } = await supabase.auth.updateUser({
    password: synthPassword(name, newPin),
    data: { pin_login_hash: await pinLoginTag(name, newPin), display_name: name },
  });
  if (error) {
    if (/same_password|different from the old/i.test(error.message || "")) throw new Error("That's already your PIN — pick a different one.");
    if (/reauthentication|session/i.test(error.message || "")) throw new Error("Please sign out and back in, then try again.");
    throw new Error(error.message || "Couldn't change the PIN.");
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

/* Teacher tool: set a new PIN for a student who forgot theirs. Runs
   through the teacher-reset-pin Edge Function (which checks the caller is
   in the `teachers` table). Returns { ok, name, newPin }. */
export async function teacherResetPin(uid, newPin) {
  let res;
  try {
    res = await supabase.functions.invoke("teacher-reset-pin", { body: { uid, newPin } });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  if (res.error) {
    let msg = "Couldn't reset the PIN.";
    const ctx = res.error.context;
    if (ctx && typeof ctx.json === "function") {
      try { const b = await ctx.json(); if (b && b.error) msg = b.error; } catch (_) { /* ignore */ }
    } else if (res.error.message) {
      msg = res.error.message;
    }
    throw new Error(msg);
  }
  return res.data || { ok: true };
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

/* ---- friends -------------------------------------------------------
   A `friendships` table (a = requester, b = target, status). RLS lets
   either party see/delete a row, the requester insert, the target
   accept. See supabase/schema.sql section 8. */

export async function sendFriendRequest(targetUid) {
  const me = await currentUid();
  if (!me || !targetUid || me === targetUid) return { error: "bad target" };
  // If they already requested me, accepting is nicer than a duplicate.
  const existing = await supabase.from("friendships").select("a,b,status").or(`and(a.eq.${targetUid},b.eq.${me}),and(a.eq.${me},b.eq.${targetUid})`).maybeSingle();
  if (existing.data) {
    if (existing.data.status === "accepted") return { ok: true, state: "friends" };
    if (existing.data.a === targetUid) { await acceptFriend(targetUid); return { ok: true, state: "friends" }; }
    return { ok: true, state: "pending" };
  }
  const { error } = await supabase.from("friendships").insert({ a: me, b: targetUid, status: "pending" });
  if (error) return { error: error.message };
  return { ok: true, state: "pending" };
}

export async function acceptFriend(fromUid) {
  const me = await currentUid();
  if (!me) return;
  await supabase.from("friendships").update({ status: "accepted" }).eq("a", fromUid).eq("b", me);
}

/* ---- async PvP: Blitz challenges ----------------------------------
   `a` challenges `b`. `a` plays first: their questions + score land in
   the row on creation. `b` later plays the SAME `questions` and their
   score is written back. Higher score wins — nothing realtime.
   See supabase/schema.sql section 9. */

export async function createBlitzChallenge(opponentUid, questions, myScore) {
  const me = await currentUid();
  if (!me || !opponentUid || me === opponentUid) return { error: "bad target" };
  const { data, error } = await supabase
    .from("blitz_challenges")
    .insert({ a: me, b: opponentUid, questions, score_a: myScore })
    .select()
    .maybeSingle();
  if (error) return { error: error.message };
  return { ok: true, challenge: data };
}

export async function submitBlitzChallengeScore(id, myScore) {
  const me = await currentUid();
  if (!me || !id) return { error: "bad" };
  const { data, error } = await supabase
    .from("blitz_challenges")
    .update({ score_b: myScore })
    .eq("id", id)
    .eq("b", me)
    .select()
    .maybeSingle();
  if (error) return { error: error.message };
  return { ok: true, challenge: data };
}

/* Every challenge involving me, newest first. [] on failure. */
export async function loadBlitzChallenges() {
  const me = await currentUid();
  if (!me) return [];
  try {
    const { data, error } = await supabase
      .from("blitz_challenges")
      .select("id,a,b,questions,score_a,score_b,created_at")
      .or(`a.eq.${me},b.eq.${me}`)
      .order("created_at", { ascending: false })
      .limit(60);
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
}

export async function deleteBlitzChallenge(id) {
  if (!id) return;
  try { await supabase.from("blitz_challenges").delete().eq("id", id); } catch (e) { /* ignore */ }
}

export async function removeFriend(otherUid) {
  const me = await currentUid();
  if (!me) return;
  await supabase.from("friendships").delete().or(`and(a.eq.${me},b.eq.${otherUid}),and(a.eq.${otherUid},b.eq.${me})`);
}

/* ---- classes / licences / assignments  (the B2B layer) -------------
   See supabase/schema.sql section 10. A teacher (uid in `teachers`)
   owns `classes`; students join with a `join_code`; a `licenses` row
   that covers a student grants the premium tier (my_entitlement). */

// Is the signed-in user a teacher? -> { uid, name } | null
export async function getMyTeacher() {
  const me = await currentUid();
  if (!me) return null;
  try {
    const { data, error } = await supabase.from("teachers").select("uid,name").eq("uid", me).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

// { premium, source?, expires_at?, note? } — never throws.
export async function getMyEntitlement() {
  try {
    const { data, error } = await supabase.rpc("my_entitlement");
    if (error || !data) return { premium: false };
    return data;
  } catch (e) { return { premium: false }; }
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1
function makeJoinCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

// Teacher creates a class. Retries on the (rare) join-code collision.
export async function createClass(name, school) {
  const me = await currentUid();
  if (!me) return { error: "not signed in" };
  for (let tries = 0; tries < 5; tries++) {
    const { data, error } = await supabase
      .from("classes")
      .insert({ teacher_uid: me, name: (name || "").trim() || "Class", school: school || null, join_code: makeJoinCode() })
      .select()
      .maybeSingle();
    if (!error) return { ok: true, class: data };
    if (!/duplicate key|unique/i.test(error.message || "")) return { error: error.message };
  }
  return { error: "Could not generate a unique code — try again." };
}

// Teacher's own classes, newest first.
export async function myTeacherClasses() {
  const me = await currentUid();
  if (!me) return [];
  try {
    const { data, error } = await supabase
      .from("classes")
      .select("id,name,school,join_code,archived,created_at")
      .eq("teacher_uid", me)
      .order("created_at", { ascending: false });
    if (error) return [];
    return data || [];
  } catch (e) { return []; }
}

export async function updateClass(id, patch) {
  try { await supabase.from("classes").update(patch).eq("id", id); } catch (e) { /* ignore */ }
}
export async function deleteClass(id) {
  try { await supabase.from("classes").delete().eq("id", id); } catch (e) { /* ignore */ }
}

// Full roster for a class the caller teaches: [{ uid, joined_at, ...profile }]
export async function classRoster(classId) {
  try {
    const { data, error } = await supabase.rpc("class_roster", { cid: classId });
    if (error) return [];
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

// Teacher removes a student from a class.
export async function removeClassMember(classId, studentUid) {
  try { await supabase.from("class_members").delete().eq("class_id", classId).eq("student_uid", studentUid); } catch (e) { /* ignore */ }
}

// Student joins by code. -> { ok, class_id, name, school, teacher_name } | { ok:false, error }
export async function joinClass(code) {
  try {
    const { data, error } = await supabase.rpc("join_class", { code });
    if (error) return { ok: false, error: error.message };
    return data || { ok: false, error: "Something went wrong." };
  } catch (e) { return { ok: false, error: "Can't reach the server." }; }
}

// Classes the signed-in student is a member of.
export async function myStudentClasses() {
  try {
    const { data, error } = await supabase.rpc("my_classes");
    if (error) return [];
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

export async function leaveClass(classId) {
  const me = await currentUid();
  if (!me) return;
  try { await supabase.from("class_members").delete().eq("class_id", classId).eq("student_uid", me); } catch (e) { /* ignore */ }
}

// Assignments for a set of class ids (works for both students and the
// teacher — RLS lets both read).
export async function loadAssignments(classIds) {
  if (!classIds || classIds.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from("assignments")
      .select("id,class_id,topic_id,title,count,due_at,created_at")
      .in("class_id", classIds)
      .order("created_at", { ascending: false });
    if (error) return [];
    return data || [];
  } catch (e) { return []; }
}

export async function createAssignment(classId, topicId, count, dueAt, title) {
  try {
    const { data, error } = await supabase
      .from("assignments")
      .insert({ class_id: classId, topic_id: topicId, count, due_at: dueAt || null, title: title || null })
      .select()
      .maybeSingle();
    if (error) return { error: error.message };
    return { ok: true, assignment: data };
  } catch (e) { return { error: "Can't reach the server." }; }
}

export async function deleteAssignment(id) {
  try { await supabase.from("assignments").delete().eq("id", id); } catch (e) { /* ignore */ }
}

// Teacher: is one of my classes covered by an active licence?
export async function classLicensed(classId) {
  try {
    const { data, error } = await supabase.rpc("class_licensed", { cid: classId });
    if (error || !data) return { licensed: false };
    return data;
  } catch (e) { return { licensed: false }; }
}

/* { friends:[uid], incoming:[uid], outgoing:[uid] } */
export async function loadFriendGraph() {
  const me = await currentUid();
  if (!me) return { friends: [], incoming: [], outgoing: [] };
  try {
    const { data, error } = await supabase.from("friendships").select("a,b,status").or(`a.eq.${me},b.eq.${me}`);
    if (error) return { friends: [], incoming: [], outgoing: [] };
    const friends = [], incoming = [], outgoing = [];
    for (const r of data || []) {
      const other = r.a === me ? r.b : r.a;
      if (r.status === "accepted") friends.push(other);
      else if (r.b === me) incoming.push(other);
      else outgoing.push(other);
    }
    return { friends, incoming, outgoing };
  } catch (e) {
    return { friends: [], incoming: [], outgoing: [] };
  }
}
