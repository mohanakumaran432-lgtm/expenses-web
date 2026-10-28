import { supabase } from './supabase'
import type { Category, Filters, Invitation, Kind, Member, Role, Transaction } from './types'

// The PostgREST query builder is typed loosely on purpose so library typing changes cannot break the build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any
const PAGE = 500

/** Friendly text for database errors. Real permission checks happen in PostgreSQL (RLS), not here. */
export function errMsg(e: unknown): string {
  const err = e as { code?: string; message?: string } | null
  switch (err?.code) {
    case '42501': return 'You are not allowed to do that.'
    case '23503': return 'That item is still used by other records.'
    case '23505': return 'That already exists.'
    case '23514': return 'That value is not allowed.'
  }
  return err?.message || 'Something went wrong. Please try again.'
}

function notAllowed(): never {
  throw Object.assign(new Error('Not allowed'), { code: '42501' })
}

async function fetchAll<T>(build: () => Q): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

export async function loadLedger(userId: string) {
  const [m, h, c] = await Promise.all([
    supabase.from('household_members').select('*').order('created_at'),
    supabase.from('households').select('id,name').limit(1),
    supabase.from('categories').select('*').order('name'),
  ])
  if (m.error) throw m.error
  if (h.error) throw h.error
  if (c.error) throw c.error
  const members = (m.data ?? []) as Member[]
  const me = members.find((x) => x.user_id === userId)
  if (!me) return null // signed in, but not part of any household
  return { me, members, categories: (c.data ?? []) as Category[], householdName: String(h.data?.[0]?.name ?? 'Household') }
}

function applyFilters(q: Q, f: Filters): Q {
  if (f.kind) q = q.eq('kind', f.kind)
  if (f.categoryId) q = q.eq('category_id', f.categoryId)
  if (f.memberId) q = q.eq('created_by', f.memberId)
  if (f.method) q = q.eq('payment_method', f.method)
  if (f.from) q = q.gte('occurred_on', f.from)
  if (f.to) q = q.lte('occurred_on', f.to)
  const text = f.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)
  if (text) q = q.ilike('description', `%${text}%`)
  return q
}

const newestFirst = (q: Q): Q =>
  q.order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).order('id')

export async function listTransactions(f: Filters, limit: number) {
  const { data, error, count } = await newestFirst(
    applyFilters(supabase.from('transactions').select('*', { count: 'exact' }), f),
  ).range(0, limit - 1)
  if (error) throw error
  return { rows: (data ?? []) as Transaction[], count: (count ?? 0) as number }
}

export const exportTransactions = (f: Filters) =>
  fetchAll<Transaction>(() => newestFirst(applyFilters(supabase.from('transactions').select('*'), f)))

export const rowsBetween = (from: string, toExclusive: string) =>
  fetchAll<Pick<Transaction, 'kind' | 'amount' | 'occurred_on' | 'category_id'>>(() =>
    newestFirst(supabase.from('transactions').select('kind,amount,occurred_on,category_id').gte('occurred_on', from).lt('occurred_on', toExclusive)),
  )

export type TxInput = Pick<Transaction, 'kind' | 'amount' | 'occurred_on' | 'category_id' | 'payment_method' | 'description'>

export async function createTransaction(householdId: string, input: TxInput) {
  // created_by is filled in by the database from the signed-in user, and RLS rejects any other value.
  const { error } = await supabase.from('transactions').insert({ household_id: householdId, ...input })
  if (error) throw error
}

export async function updateTransaction(id: string, input: TxInput) {
  const { data, error } = await supabase.from('transactions').update(input).eq('id', id).select('id')
  if (error) throw error
  if (!data?.length) notAllowed() // row hidden by RLS: not yours, or already gone
}

export async function deleteTransaction(id: string) {
  const { data, error } = await supabase.from('transactions').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data?.length) notAllowed()
}

export async function addCategory(householdId: string, kind: Kind, name: string) {
  const { error } = await supabase.from('categories').insert({ household_id: householdId, kind, name: name.trim() })
  if (error) throw error
}

export async function renameCategory(id: string, name: string) {
  const { data, error } = await supabase.from('categories').update({ name: name.trim() }).eq('id', id).select('id')
  if (error) throw error
  if (!data?.length) notAllowed()
}

export async function deleteCategory(id: string) {
  const { data, error } = await supabase.from('categories').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data?.length) notAllowed()
}

export async function setMemberRole(userId: string, role: Role) {
  const { data, error } = await supabase.from('household_members').update({ role }).eq('user_id', userId).select('user_id')
  if (error) throw error
  if (!data?.length) notAllowed()
}

export async function setDisplayName(userId: string, name: string) {
  const { data, error } = await supabase.from('household_members').update({ display_name: name.trim() }).eq('user_id', userId).select('user_id')
  if (error) throw error
  if (!data?.length) notAllowed()
}

export async function removeMember(userId: string) {
  const { data, error } = await supabase.from('household_members').delete().eq('user_id', userId).select('user_id')
  if (error) throw error
  if (!data?.length) notAllowed()
}

export async function listInvitations(): Promise<Invitation[]> {
  const { data, error } = await supabase.from('invitations').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Invitation[]
}

export async function addInvitation(householdId: string, email: string, displayName: string) {
  const { error } = await supabase
    .from('invitations')
    .insert({ household_id: householdId, email: email.trim().toLowerCase(), display_name: displayName.trim() || null })
  if (error) throw error
}

export async function deleteInvitation(id: string) {
  const { data, error } = await supabase.from('invitations').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data?.length) notAllowed()
}
