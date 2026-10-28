import { useState } from 'react'
import type { FormEvent } from 'react'
import { authLinkError, supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(
    authLinkError ? 'That link is invalid or has expired. Use "Forgot password?" below, or ask the owner to invite you again.' : '',
  )

  async function signIn(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setMsg('Email or password is incorrect.')
    setBusy(false)
  }

  async function forgot() {
    if (!email.trim()) {
      setMsg('Type your email above first.')
      return
    }
    setBusy(true)
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin })
    setMsg('If that email belongs to a family member, a reset link is on its way.')
    setBusy(false)
  }

  return (
    <main className="auth">
      <img src="/icons/icon-192.png" alt="" width="72" height="72" />
      <h1>Family Ledger</h1>
      <p className="muted">Private household income and expenses</p>
      <form onSubmit={signIn} className="card stack">
        <label className="field">
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {msg && <p role="alert" className="msg">{msg}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</button>
        <button type="button" className="btn link" onClick={forgot} disabled={busy}>Forgot password?</button>
      </form>
      <p className="muted small">Access is by invitation only.</p>
    </main>
  )
}
