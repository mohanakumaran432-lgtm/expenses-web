import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/+$/, '')
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim()

// Read invite / password-reset link info BEFORE the client removes it from the address bar.
const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
export const authLinkType = hash.get('type') // 'invite' | 'recovery' | null
export const authLinkError = hash.get('error_description') // e.g. "Email link is invalid or has expired"

function looksSecret(k: string): boolean {
  if (k.startsWith('sb_secret_')) return true
  try {
    return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'
  } catch {
    return false
  }
}

export const configError: string | null =
  !url || !key
    ? 'This app is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (Cloudflare Pages > Settings > Variables and Secrets), then redeploy.'
    : !/^https:\/\/[^/\s]+$/.test(url)
      ? 'VITE_SUPABASE_URL must look like https://YOUR-PROJECT-REF.supabase.co'
      : looksSecret(key)
        ? 'A secret key was supplied. Use the PUBLISHABLE key only, and rotate the secret key you pasted.'
        : null

// Only used when configError is null (main.tsx never renders the app otherwise).
export const supabase = (
  configError ? null : createClient(url as string, key as string, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
) as SupabaseClient
