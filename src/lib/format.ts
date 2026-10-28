// Money is handled in fils (1 AED = 100 fils) as whole numbers to avoid floating-point drift.
const TZ = 'Asia/Dubai'

export const toFils = (aed: number): number => Math.round(aed * 100)

/** Accepts "12", "12.5", "1,234.50": greater than zero, up to 10 digits and 2 decimals. */
export function parseAmount(input: string): number | null {
  const t = input.trim().replace(/,/g, '')
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t)
  return n > 0 ? n : null
}

export const formatAed = (fils: number): string =>
  new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED' }).format(fils / 100)

/** Today's date (YYYY-MM-DD) in Dubai, regardless of the device's own time zone. */
export const todayDubai = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

export const currentMonth = (now: Date = new Date()): string => todayDubai(now).slice(0, 7)

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

/** [from, toExclusive) date strings covering one month. */
export function monthRange(month: string): { from: string; toExclusive: string } {
  return { from: `${month}-01`, toExclusive: `${addMonths(month, 1)}-01` }
}

export const formatMonth = (month: string): string =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))

export const formatDate = (day: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

export const formatDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date(iso))

export const isValidDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
