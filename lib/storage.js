import { supabase } from "./supabaseClient";

/* ---------------------------------------------------------
   Same get/set/delete/list(key, shared) surface the ported
   component expects, backed by the kv_store table.

   Private data is scoped to the signed-in user's real
   Supabase Auth id (auth.uid()). Row Level Security on
   kv_store enforces that a row with scope = "<uid>" can only
   be read or written by that user — so this is now real
   ownership, not an honour-system client id.

   "shared" rows (scope = "shared") hold the teacher-authored
   question banks: readable by anyone, writable only by uids
   in the `teachers` table (see supabase/schema.sql).

   Leaderboard / parent-link reads that need OTHER users' data
   go through SECURITY DEFINER RPCs in lib/auth.js, not this
   file — RLS deliberately hides those rows from direct queries.
--------------------------------------------------------- */

async function currentScope(shared) {
  if (shared) return "shared";
  const { data } = await supabase.auth.getSession();
  const uid = data && data.session && data.session.user && data.session.user.id;
  if (!uid) throw new Error("not signed in");
  return uid;
}

export const storage = {
  async get(key, shared = false) {
    const scope = await currentScope(shared);
    const { data, error } = await supabase
      .from("kv_store")
      .select("value")
      .eq("scope", scope)
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`storage key not found: ${key}`);
    return { key, value: data.value, shared };
  },

  async set(key, value, shared = false) {
    const scope = await currentScope(shared);
    const { error } = await supabase
      .from("kv_store")
      .upsert({ scope, key, value }, { onConflict: "scope,key" });
    if (error) throw error;
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    const scope = await currentScope(shared);
    const { error } = await supabase
      .from("kv_store")
      .delete()
      .eq("scope", scope)
      .eq("key", key);
    if (error) throw error;
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    const scope = await currentScope(shared);
    const { data, error } = await supabase
      .from("kv_store")
      .select("key")
      .eq("scope", scope)
      .like("key", `${prefix}%`);
    if (error) throw error;
    return { keys: (data || []).map((r) => r.key), prefix, shared };
  },
};
