/**
 * Shared Supabase configuration — single source of truth for all analytics modules.
 *
 * Credentials MUST be provided via environment variables:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * If either is missing, all analytics calls are silently skipped.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** Returns true when Supabase credentials are configured */
export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "";
}
