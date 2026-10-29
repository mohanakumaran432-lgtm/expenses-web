import { useCallback, useEffect, useState } from 'react'
import {
  addCategory, addInvitation, deleteCategory, deleteInvitation, errMsg, listInvitations,
  removeMember, renameCategory, setDisplayName, setMemberRole,
} from '../lib/data'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/format'
import type { Category, Invitation, Kind, Member, Role } from '../lib/types'
import { PasswordForm } from './SetPassword'

// Runs an action, shows any error, and refreshes afterwards. (Permissions are enforced by the database.)
function useRun(after?: () => void | Promise<void>) {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg('')
    try {
      await fn()
      await after?.()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return { msg, busy, run, setMsg }
}

interface Props {
  me: Member
  members: Member[]
  categories: Category[]
  email: string
  onChanged: () => Promise<void>
}

export default function Settings({ me, members, categories, email, onChanged }: Props) {
  const owner = me.role === 'owner'
  return (
    <div className="stack">
      <AccountCard me={me} email={email} onChanged={onChanged} />
      {owner ? (
        <>
          <MembersCard me={me} members={members} onChanged={onChanged} />
          <InvitesCard householdId={me.household_id} />
          <CategoriesCard householdId={me.household_id} categories={categories} onChanged={onChanged} />
        </>
      ) : (
        <p className="muted small">Only owners can manage members and categories.</p>
      )}
    </div>
  )
}

function AccountCard({ me, email, onChanged }: { me: Member; email: string; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(me.display_name)
  const [pwDone, setPwDone] = useState(false)
  const { msg, busy, run } = useRun(onChanged)
  return (
    <section className="card stack">
      <h3>Your account</h3>
      <p className="muted small">{email} · {me.role === 'owner' ? 'Owner' : 'Member'}</p>
      <div className="inline">
        <label className="field grow">Display name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !name.trim() || name.trim() === me.display_name} onClick={() => run(() => setDisplayName(me.user_id, name))}>Save</button>
      </div>
      {msg && <p role="alert" className="msg">{msg}</p>}
      <details>
        <summary>Change password</summary>
        <PasswordForm label="Update password" onDone={() => setPwDone(true)} />
        {pwDone && <p className="ok">Password updated.</p>}
      </details>
      <button className="btn" onClick={() => void supabase.auth.signOut()}>Sign out</button>
    </section>
  )
}

function MembersCard({ me, members, onChanged }: { me: Member; members: Member[]; onChanged: () => Promise<void> }) {
  const { msg, busy, run } = useRun(onChanged)
  return (
    <section className="card stack">
      <h3>Family members</h3>
      {members.map((m) => (
        <div key={m.user_id} className="inline spread">
          <span>
            <strong>{m.display_name}</strong>
            <span className="muted small block">{m.email}</span>
          </span>
          {m.user_id === me.user_id ? (
            <span className="chip">You · {m.role}</span>
          ) : (
            <span className="inline">
              <select aria-label={`Role of ${m.display_name}`} value={m.role} disabled={busy} onChange={(e) => run(() => setMemberRole(m.user_id, e.target.value as Role))}>
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
              <button className="btn danger" disabled={busy} onClick={() => window.confirm(`Remove ${m.display_name}? They lose access immediately; their past transactions stay.`) && run(() => removeMember(m.user_id))}>Remove</button>
            </span>
          )}
        </div>
      ))}
      {msg && <p role="alert" className="msg">{msg}</p>}
    </section>
  )
}

function InvitesCard({ householdId }: { householdId: string }) {
  const [list, setList] = useState<Invitation[] | null>(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const refresh = useCallback(async () => setList(await listInvitations()), [])
  const { msg, busy, run, setMsg } = useRun(refresh)

  useEffect(() => {
    refresh().catch((e) => setMsg(errMsg(e)))
  }, [refresh, setMsg])

  const status = (i: Invitation) => (i.accepted_at ? 'Joined' : new Date(i.expires_at) < new Date() ? 'Expired' : 'Waiting')
  return (
    <section className="card stack">
      <h3>Invitations</h3>
      <p className="muted small">Step 1: add the email here. Step 2: in Supabase open Authentication, then Users, then Add user, then Create new user. Use the same email, give a first password (10+ characters) and tick Auto Confirm User. Share the password privately; they can change it under Settings.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await addInvitation(householdId, email, name); setEmail(''); setName('') }) }}>
        <label className="field">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">Name (optional)<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn primary" disabled={busy}>Add invitation</button>
      </form>
      {msg && <p role="alert" className="msg">{msg}</p>}
      {list?.map((i) => (
        <div key={i.id} className="inline spread">
          <span>{i.email}<span className="muted small block">{status(i)} · {formatDate(i.created_at.slice(0, 10))}</span></span>
          <button className="btn" disabled={busy} onClick={() => run(() => deleteInvitation(i.id))}>Remove</button>
        </div>
      ))}
    </section>
  )
}

function CategoriesCard({ householdId, categories, onChanged }: { householdId: string; categories: Category[]; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<Kind>('expense')
  const [name, setName] = useState('')
  const { msg, busy, run } = useRun(onChanged)
  return (
    <section className="card stack">
      <h3>Categories</h3>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { await addCategory(householdId, kind, name); setName('') }) }}>
        <select aria-label="Category type" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
        <input aria-label="New category name" className="grow" required maxLength={40} placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={busy}>Add</button>
      </form>
      {msg && <p role="alert" className="msg">{msg}</p>}
      {(['expense', 'income'] as const).map((k) => (
        <div key={k}>
          <h4>{k === 'expense' ? 'Expense categories' : 'Income categories'}</h4>
          {categories.filter((c) => c.kind === k).map((c) => (
            <div key={c.id} className="inline spread">
              <span>{c.name}</span>
              <span className="inline">
                <button className="btn" disabled={busy} onClick={() => { const n = window.prompt('Rename category', c.name); if (n && n.trim() && n.trim() !== c.name) void run(() => renameCategory(c.id, n)) }}>Rename</button>
                <button className="btn danger" disabled={busy} onClick={() => window.confirm(`Delete "${c.name}"? (Not possible while transactions use it.)`) && run(() => deleteCategory(c.id))}>Delete</button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}
