import { supabase } from "./supabaseClient";

/* ---------------------------------------------------------
   This mimics Claude artifact's window.storage API — same
   get/set/delete/list(key, shared) signatures — backed by a
   real Supabase table (kv_store), so the ported component
   needed almost no logic changes.

   IMPORTANT — this is NOT real authentication. "Private" data
   is scoped by a random id generated in the browser and saved
   to localStorage. Anyone who opens dev tools can read or
   overwrite another visitor's client id and see their data;
   there is no server-side check that a request actually comes
   from the student it claims to. For a real launch, replace
   this with Supabase Auth (e.g. magic-link email login) and
   add Row Level Security policies to kv_store so a row can
   only be read/written by the user_id that owns it. This file
   is the one place that change needs to happen — the rest of
   the app doesn't need to know how storage is implemented.
--------------------------------------------------------- */

function getClientId() {
  if (typeof window === "undefined") return "server";
  let id = window.localStorage.getItem("mub_client_id");
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem("mub_client_id", id);
  }
  return id;
}

function scopeFor(shared) {
  return shared ? "shared" : `private:${getClientId()}`;
}

export const storage = {
  async get(key, shared = false) {
    const { data, error } = await supabase
      .from("kv_store")
      .select("value")
      .eq("scope", scopeFor(shared))
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`storage key not found: ${key}`);
    return { key, value: data.value, shared };
  },

  async set(key, value, shared = false) {
    const { error } = await supabase
      .from("kv_store")
      .upsert({ scope: scopeFor(shared), key, value }, { onConflict: "scope,key" });
    if (error) throw error;
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    const { error } = await supabase
      .from("kv_store")
      .delete()
      .eq("scope", scopeFor(shared))
      .eq("key", key);
    if (error) throw error;
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    const { data, error } = await supabase
      .from("kv_store")
      .select("key")
      .eq("scope", scopeFor(shared))
      .like("key", `${prefix}%`);
    if (error) throw error;
    return { keys: (data || []).map((r) => r.key), prefix, shared };
  },
};
