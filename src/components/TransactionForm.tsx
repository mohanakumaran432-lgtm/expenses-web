import { useState } from 'react'
import type { FormEvent } from 'react'
import { createTransaction, deleteTransaction, errMsg, updateTransaction } from '../lib/data'
import { isValidDay, parseAmount, todayDubai } from '../lib/format'
import { PAYMENT_LABELS, PAYMENT_METHODS } from '../lib/types'
import type { Category, Kind, PaymentMethod, Transaction } from '../lib/types'

interface Props {
  householdId: string
  categories: Category[]
  tx: Transaction | null // null = add a new one
  onClose: () => void
  onSaved: () => void
}

export default function TransactionForm({ householdId, categories, tx, onClose, onSaved }: Props) {
  const [kind, setKind] = useState<Kind>(tx?.kind ?? 'expense')
  const [amount, setAmount] = useState(tx ? tx.amount.toFixed(2) : '')
  const [date, setDate] = useState(tx?.occurred_on ?? todayDubai())
  const [categoryId, setCategoryId] = useState(tx?.category_id ?? '')
  const [method, setMethod] = useState<PaymentMethod>(tx?.payment_method ?? 'card')
  const [description, setDescription] = useState(tx?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const options = categories.filter((c) => c.kind === kind)
  const chosen = options.some((c) => c.id === categoryId) ? categoryId : (options[0]?.id ?? '')

  async function save(e: FormEvent) {
    e.preventDefault()
    const value = parseAmount(amount)
    if (value === null) return setError('Enter an amount above 0, with up to 2 decimals.')
    if (!isValidDay(date)) return setError('Pick a valid date.')
    if (!chosen) return setError('Choose a category (the owner can add categories in Settings).')
    setBusy(true)
    setError('')
    try {
      const input = { kind, amount: value, occurred_on: date, category_id: chosen, payment_method: method, description: description.trim() }
      if (tx) await updateTransaction(tx.id, input)
      else await createTransaction(householdId, input)
      onSaved()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  async function remove() {
    if (!tx || !window.confirm('Delete this transaction?')) return
    setBusy(true)
    setError('')
    try {
      await deleteTransaction(tx.id)
      onSaved()
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <form className="sheet stack" role="dialog" aria-modal="true" aria-label={tx ? 'Edit transaction' : 'Add transaction'} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{tx ? 'Edit transaction' : 'Add transaction'}</h2>
        <div className="seg" role="group" aria-label="Type">
          <button type="button" className={kind === 'expense' ? 'on' : ''} onClick={() => setKind('expense')}>Expense</button>
          <button type="button" className={kind === 'income' ? 'on' : ''} onClick={() => setKind('income')}>Income</button>
        </div>
        <label className="field">
          Amount (AED)
          <input inputMode="decimal" autoComplete="off" required placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          Date
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          Category
          <select value={chosen} onChange={(e) => setCategoryId(e.target.value)}>
            {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field">
          Payment method
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
          </select>
        </label>
        <label className="field">
          Description
          <textarea rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <p role="alert" className="msg">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {tx && <button type="button" className="btn danger" onClick={remove} disabled={busy}>Delete</button>}
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  )
}
