import { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { MIN_PASSWORD } from '../lib/types'

export function PasswordForm({ onDone, label }: { onDone: () => void; label: string }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pw.length < MIN_PASSWORD) return setMsg(`Use at least ${MIN_PASSWORD} characters.`)
    if (pw !== pw2) return setMsg('The two passwords do not match.')
    setBusy(true)
    setMsg('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return setMsg(error.message)
    setPw('')
    setPw2('')
    onDone()
  }

  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        New password
        <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label className="field">
        Repeat password
        <input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      {msg && <p role="alert" className="msg">{msg}</p>}
      <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : label}</button>
    </form>
  )
}

export default function SetPassword({ onDone }: { onDone: () => void }) {
  return (
    <main className="auth">
      <h1>Choose your password</h1>
      <p className="muted">You will use it to sign in from now on.</p>
      <div className="card">
        <PasswordForm label="Save password" onDone={onDone} />
      </div>
    </main>
  )
}
