import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null = no backend configured, the app runs in demo mode with simulated data. */
export const supabase: SupabaseClient | null = url && anon ? createClient(url, anon) : null;
export const functionsUrl = url ? `${url}/functions/v1/api` : "";
