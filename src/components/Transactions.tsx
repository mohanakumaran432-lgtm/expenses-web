import { useEffect, useMemo, useState } from 'react'
import { errMsg, exportTransactions, listTransactions } from '../lib/data'
import { toCsv } from '../lib/csv'
import { formatAed, formatDate, todayDubai, toFils } from '../lib/format'
import { EMPTY_FILTERS, PAYMENT_LABELS, PAYMENT_METHODS } from '../lib/types'
import type { Category, Filters, Kind, Member, PaymentMethod, Transaction } from '../lib/types'

const STEP = 50

interface Props {
  me: Member
  members: Member[]
  categories: Category[]
  version: number
  onEdit: (tx: Transaction) => void
}

export default function Transactions({ me, members, categories, version, onEdit }: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [searchText, setSearchText] = useState('') // debounced copy of filters.q
  const [limit, setLimit] = useState(STEP)
  const [data, setData] = useState<{ rows: Transaction[]; count: number } | null>(null)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSearchText(filters.q), 300)
    return () => clearTimeout(t)
  }, [filters.q])
  const effective = useMemo(() => ({ ...filters, q: searchText }), [filters, searchText])

  useEffect(() => {
    let live = true
    setError('')
    listTransactions(effective, limit)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(errMsg(e)))
    return () => {
      live = false
    }
  }, [effective, limit, version])

  const change = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setLimit(STEP)
  }
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Unknown'
  const who = (id: string | null) => members.find((m) => m.user_id === id)?.display_name ?? 'Former member'
  // UI hint only. The database (RLS) is what actually enforces who may edit or delete.
  const canEdit = (t: Transaction) => me.role === 'owner' || t.created_by === me.user_id
  const catOptions = categories.filter((c) => !filters.kind || c.kind === filters.kind)
  const activeFilters = Object.entries(filters).some(([k, v]) => k !== 'q' && v !== '')

  async function exportCsv() {
    setExporting(true)
    setError('')
    try {
      const rows = await exportTransactions(effective)
      const csv = toCsv([
        ['Date', 'Type', 'Amount (AED)', 'Category', 'Payment method', 'Description', 'Added by'],
        ...rows.map((t) => [t.occurred_on, t.kind, t.amount.toFixed(2), catName(t.category_id), PAYMENT_LABELS[t.payment_method], t.description, who(t.created_by)]),
      ])
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `ledger-${todayDubai()}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="stack">
      <input className="search" type="search" placeholder="Search descriptions…" aria-label="Search descriptions" value={filters.q} onChange={(e) => change({ q: e.target.value })} />
      <details className="card filters" open={activeFilters}>
        <summary>Filters{activeFilters ? ' (on)' : ''}</summary>
        <div className="grid2">
          <label className="field">Type
            <select value={filters.kind} onChange={(e) => change({ kind: e.target.value as '' | Kind, categoryId: '' })}>
              <option value="">All</option><option value="expense">Expenses</option><option value="income">Income</option>
            </select>
          </label>
          <label className="field">Category
            <select value={filters.categoryId} onChange={(e) => change({ categoryId: e.target.value })}>
              <option value="">All</option>
              {catOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">Added by
            <select value={filters.memberId} onChange={(e) => change({ memberId: e.target.value })}>
              <option value="">Everyone</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
            </select>
          </label>
          <label className="field">Payment
            <select value={filters.method} onChange={(e) => change({ method: e.target.value as '' | PaymentMethod })}>
              <option value="">All</option>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
            </select>
          </label>
          <label className="field">From<input type="date" value={filters.from} onChange={(e) => change({ from: e.target.value })} /></label>
          <label className="field">To<input type="date" value={filters.to} onChange={(e) => change({ to: e.target.value })} /></label>
        </div>
        <button className="btn link" onClick={() => change({ ...EMPTY_FILTERS })}>Clear filters</button>
      </details>

      {error && <p role="alert" className="msg">{error}</p>}
      {!data && !error && <p className="muted center">Loading…</p>}
      {data && (
        <>
          <div className="line">
            <span className="muted small">{data.count} transaction{data.count === 1 ? '' : 's'}</span>
            <button className="btn" onClick={exportCsv} disabled={exporting || data.count === 0}>{exporting ? 'Preparing…' : 'Export CSV'}</button>
          </div>
          {data.rows.length === 0 && <p className="card muted center">No transactions match.</p>}
          <ul className="txlist">
            {data.rows.map((t) => (
              <li key={t.id}>
                <button className="tx" disabled={!canEdit(t)} onClick={() => onEdit(t)}>
                  <span>
                    <strong>{catName(t.category_id)}</strong>
                    {t.description && <span className="muted small block">{t.description}</span>}
                    <span className="muted small block">{formatDate(t.occurred_on)} · {PAYMENT_LABELS[t.payment_method]} · {who(t.created_by)}</span>
                  </span>
                  <span className={t.kind === 'income' ? 'pos' : 'neg'}>{t.kind === 'income' ? '+' : '−'}{formatAed(toFils(t.amount))}</span>
                </button>
              </li>
            ))}
          </ul>
          {data.rows.length < data.count && <button className="btn" onClick={() => setLimit((l) => l + STEP)}>Show more</button>}
        </>
      )}
    </div>
  )
}
