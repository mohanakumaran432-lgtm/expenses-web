export type Role = 'owner' | 'member'
export type Kind = 'income' | 'expense'

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  other: 'Other',
}

export const MIN_PASSWORD = 10

export interface Member {
  user_id: string
  household_id: string
  role: Role
  display_name: string
  email: string
}

export interface Category {
  id: string
  household_id: string
  kind: Kind
  name: string
}

export interface Transaction {
  id: string
  household_id: string
  created_by: string | null
  kind: Kind
  amount: number
  occurred_on: string // YYYY-MM-DD
  category_id: string
  payment_method: PaymentMethod
  description: string
  created_at: string
}

export interface Invitation {
  id: string
  email: string
  role: Role
  display_name: string | null
  created_at: string
  expires_at: string
  accepted_at: string | null
}

export interface Filters {
  q: string
  kind: '' | Kind
  categoryId: string
  memberId: string
  method: '' | PaymentMethod
  from: string
  to: string
}

export const EMPTY_FILTERS: Filters = { q: '', kind: '', categoryId: '', memberId: '', method: '', from: '', to: '' }
