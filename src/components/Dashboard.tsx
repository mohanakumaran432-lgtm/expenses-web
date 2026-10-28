import { useEffect, useMemo, useState } from 'react'
import { errMsg, rowsBetween } from '../lib/data'
import { addMonths, currentMonth, formatAed, formatMonth, monthRange } from '../lib/format'
import { byCategory, byMonth, totals } from '../lib/summary'
import type { Row } from '../lib/summary'
import type { Category } from '../lib/types'

type Item = { categoryId: string; fils: number }

function CategoryList({ title, items, total, name }: { title: string; items: Item[]; total: number; name: (id: string) => string }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {items.length === 0 && <p className="muted">Nothing this month.</p>}
      {items.map((i) => (
        <div key={i.categoryId} className="catrow">
          <div className="line">
            <span>{name(i.categoryId)}</span>
            <span>{formatAed(i.fils)}</span>
          </div>
          <div className="bar" aria-hidden="true">
            <i style={{ width: `${total ? Math.round((i.fils / total) * 100) : 0}%` }} />
          </div>
        </div>
      ))}
    </section>
  )
}

export default function Dashboard({ categories, version }: { categories: Category[]; version: number }) {
  const [month, setMonth] = useState(currentMonth())
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setRows(null)
    setError('')
    // Fetch the selected month plus the 5 before it, for the 6-month summary.
    rowsBetween(`${addMonths(month, -5)}-01`, monthRange(month).toExclusive)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(errMsg(e)))
    return () => {
      live = false
    }
  }, [month, version])

  const view = useMemo(() => {
    if (!rows) return null
    const inMonth = rows.filter((r) => r.occurred_on.startsWith(month))
    const months = Array.from({ length: 6 }, (_, i) => addMonths(month, -i))
    return { t: totals(inMonth), exp: byCategory(inMonth, 'expense'), inc: byCategory(inMonth, 'income'), history: byMonth(rows, months) }
  }, [rows, month])

  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Unknown'

  return (
    <div className="stack">
      <div className="monthbar">
        <button className="btn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <h2>{formatMonth(month)}</h2>
        <button className="btn" aria-label="Next month" disabled={month >= currentMonth()} onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </div>
      {error && <p role="alert" className="msg">{error}</p>}
      {!view && !error && <p className="muted center">Loading…</p>}
      {view && (
        <>
          <div className="tiles">
            <div className="tile"><span>Income</span><strong className="pos">{formatAed(view.t.income)}</strong></div>
            <div className="tile"><span>Expenses</span><strong className="neg">{formatAed(view.t.expense)}</strong></div>
            <div className="tile wide"><span>Balance</span><strong className={view.t.balance < 0 ? 'neg' : 'pos'}>{formatAed(view.t.balance)}</strong></div>
          </div>
          <CategoryList title="Expenses by category" items={view.exp} total={view.t.expense} name={name} />
          <CategoryList title="Income by category" items={view.inc} total={view.t.income} name={name} />
          <section className="card">
            <h3>Last 6 months</h3>
            <table>
              <thead>
                <tr><th>Month</th><th>Income</th><th>Expenses</th><th>Balance</th></tr>
              </thead>
              <tbody>
                {view.history.map((m) => (
                  <tr key={m.month}>
                    <td>{formatMonth(m.month)}</td>
                    <td>{formatAed(m.income)}</td>
                    <td>{formatAed(m.expense)}</td>
                    <td className={m.balance < 0 ? 'neg' : ''}>{formatAed(m.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
