import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly at build/runtime instead of silently returning empty data,
  // which is much easier to debug than a blank dashboard.
  console.warn(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
    "Set them in .env.local (local dev) or your Vercel project's Environment Variables (deployed)."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
