/**
 * supabase.js — singleton Supabase client for server-side use.
 * Uses the service key so it can bypass Row Level Security.
 */

const { createClient } = require("@supabase/supabase-js");

const url        = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!url || !serviceKey) {
  console.warn("[Supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY missing");
}

const supabase = createClient(url || "", serviceKey || "", {
  auth: { persistSession: false },
});

module.exports = supabase;
