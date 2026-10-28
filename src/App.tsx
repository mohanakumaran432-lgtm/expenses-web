import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { authLinkType, supabase } from './lib/supabase'
import { errMsg, loadLedger } from './lib/data'
import type { Category, Member, Transaction } from './lib/types'
import Login from './components/Login'
import SetPassword from './components/SetPassword'
import Dashboard from './components/Dashboard'
import Transactions from './components/Transactions'
import TransactionForm from './components/TransactionForm'
import Settings from './components/Settings'

type Ledger = { me: Member; members: Member[]; categories: Category[]; householdName: string }
type Tab = 'home' | 'list' | 'settings'

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined) // undefined = still checking
  const [needsPassword, setNeedsPassword] = useState(authLinkType === 'invite' || authLinkType === 'recovery')

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  if (session === undefined) return <p className="center muted">Loading…</p>
  if (!session) return <Login />
  if (needsPassword) {
    return (
      <SetPassword
        onDone={() => {
          window.history.replaceState(null, '', window.location.pathname)
          setNeedsPassword(false)
        }}
      />
    )
  }
  return <LedgerApp session={session} />
}

function LedgerApp({ session }: { session: Session }) {
  const [ledger, setLedger] = useState<Ledger | null | 'none'>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('home')
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null)
  const [version, setVersion] = useState(0) // bump to make lists refetch

  const reload = useCallback(async () => {
    try {
      setLedger((await loadLedger(session.user.id)) ?? 'none')
      setError('')
    } catch (e) {
      setError(errMsg(e))
    }
  }, [session.user.id])
  useEffect(() => {
    void reload()
  }, [reload])

  const signOut = () => void supabase.auth.signOut()

  if (error) {
    return (
      <main className="auth">
        <p role="alert" className="card msg">{error}</p>
        <button className="btn primary" onClick={() => void reload()}>Try again</button>
        <button className="btn link" onClick={signOut}>Sign out</button>
      </main>
    )
  }
  if (ledger === null) return <p className="center muted">Loading…</p>
  if (ledger === 'none') {
    return (
      <main className="auth">
        <h1>No household access</h1>
        <p className="card">Your login ({session.user.email}) is not linked to a household. Ask the household owner to invite you.</p>
        <button className="btn" onClick={signOut}>Sign out</button>
      </main>
    )
  }

  const { me, members, categories, householdName } = ledger
  return (
    <div className="app">
      <header className="top">
        <strong>{householdName}</strong>
        <span className="muted small">{me.display_name}</span>
      </header>
      <main className="content">
        {tab === 'home' && <Dashboard categories={categories} version={version} />}
        {tab === 'list' && <Transactions me={me} members={members} categories={categories} version={version} onEdit={setEditing} />}
        {tab === 'settings' && <Settings me={me} members={members} categories={categories} email={session.user.email ?? ''} onChanged={reload} />}
      </main>
      <nav className="tabs" aria-label="Main">
        <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}>Home</button>
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>Transactions</button>
        <button className="add" onClick={() => setEditing('new')}>+ Add</button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>
      </nav>
      {editing && (
        <TransactionForm
          householdId={me.household_id}
          categories={categories}
          tx={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setVersion((v) => v + 1)
          }}
        />
      )}
    </div>
  )
}
