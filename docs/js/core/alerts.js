// Budget alerts shown INSIDE the app. A web app on an iPhone cannot wake itself up in the background or send a
// notification without a push server, and this app has no server on purpose, so alerts appear while the app is open.
//
// Privacy: by default an alert contains no amounts and no budget names (the screen may be seen by someone else).
// Details appear only when the person has switched on "Show amounts in alerts".

import { budgetStatuses, planBudgetAlerts, periodStartInKey } from './budgets.js';
import { LedgerDirectory } from './snapshot.js';
import { LocalDate } from './localdate.js';
import { subtract } from './money.js';

export const GENERIC_BUDGET_TITLE = 'Budget alert';
export const GENERIC_BUDGET_BODY = 'One of your budgets needs attention. Open Budgets to review it.';

/** Keys of periods that started longer ago than this are forgotten, so the memory stays small. */
export const KEEP_DAYS = 400;

/** The text of one alert. `status` is the budget's current status (may be missing if the budget was just deleted). */
export function budgetAlertMessage(alert, status, showDetails, moneyFormatter) {
  if (!showDetails) {
    return { id: alert.key, kind: 'budget', title: GENERIC_BUDGET_TITLE, body: GENERIC_BUDGET_BODY };
  }
  let title;
  if (alert.isOver) title = `${alert.budgetName}: over budget`;
  else if (alert.threshold >= 100) title = `${alert.budgetName}: budget reached`;
  else title = `${alert.budgetName}: ${alert.threshold}% used`;

  let body = 'Open Budgets to review it.';
  if (status) {
    body = `${moneyFormatter.string(status.spent)} of ${moneyFormatter.string(status.limit)} spent.`;
    body += status.isOver
      ? ` Over by ${moneyFormatter.string(subtract(status.spent, status.limit))}.`
      : ` ${moneyFormatter.string(status.remaining)} left.`;
  }
  return { id: alert.key, kind: 'budget', title, body };
}

/**
 * Run after any change to the ledger. Returns the alerts to show now and the new set of remembered keys.
 * Everything reached is remembered even when alerts are off, so switching them on later does not announce old news.
 *
 * @param snapshot   the ledger
 * @param today      a LocalDate
 * @param firedKeys  a Set of keys already announced (the caller stores it)
 * @param formatter  a DisplayFormatter
 */
export function evaluateBudgetAlerts({ snapshot, today, firedKeys, formatter }) {
  const directory = new LedgerDirectory(snapshot);
  const statuses = budgetStatuses(snapshot.budgets, snapshot.expenses, directory, today, snapshot.settings.firstWeekday);
  const plan = planBudgetAlerts(statuses, firedKeys);

  const cutoff = today.addingDays(-KEEP_DAYS);
  const updated = new Set();
  for (const key of new Set([...firedKeys, ...plan.reachedKeys])) {
    const text = periodStartInKey(key);
    const start = text === null ? null : LocalDate.fromISO(text);
    if (start && start.raw >= cutoff.raw) updated.add(key);
  }
  const changed = updated.size !== firedKeys.size || [...updated].some((key) => !firedKeys.has(key));

  const messages = [];
  if (snapshot.settings.budgetAlertsEnabled) {
    for (const alert of plan.alerts) {
      const status = statuses.find((s) => s.budget.id === alert.budgetID) || null;
      messages.push(budgetAlertMessage(alert, status, snapshot.settings.notificationsShowAmounts, formatter.money));
    }
  }
  return { messages, firedKeys: updated, changed };
}
