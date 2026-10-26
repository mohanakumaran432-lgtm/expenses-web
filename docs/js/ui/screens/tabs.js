// The root screen of each tab.

import { createHome } from './home.js';
import { createTransactions } from './transactions.js';
import { createReports } from './reports.js';
import { createBudgets } from './budgets.js';
import { createSettings } from './settings.js';

export const tabFactories = {
  home: createHome,
  transactions: createTransactions,
  reports: createReports,
  budgets: createBudgets,
  settings: createSettings,
};
