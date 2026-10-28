import type { Kind } from './types.ts'
import { toFils } from './format.ts'

export interface Row {
  kind: Kind
  amount: number
  occurred_on: string
  category_id: string
}

export function totals(rows: Row[]): { income: number; expense: number; balance: number } {
  let income = 0
  let expense = 0
  for (const r of rows) {
    if (r.kind === 'income') income += toFils(r.amount)
    else expense += toFils(r.amount)
  }
  return { income, expense, balance: income - expense }
}

/** Fils per category for one kind, largest first. */
export function byCategory(rows: Row[], kind: Kind): { categoryId: string; fils: number }[] {
  const sums = new Map<string, number>()
  for (const r of rows) if (r.kind === kind) sums.set(r.category_id, (sums.get(r.category_id) ?? 0) + toFils(r.amount))
  return [...sums].map(([categoryId, fils]) => ({ categoryId, fils })).sort((a, b) => b.fils - a.fils)
}

/** One entry per requested month (YYYY-MM), newest first as given. */
export function byMonth(rows: Row[], months: string[]): { month: string; income: number; expense: number; balance: number }[] {
  return months.map((month) => ({ month, ...totals(rows.filter((r) => r.occurred_on.startsWith(month))) }))
}
