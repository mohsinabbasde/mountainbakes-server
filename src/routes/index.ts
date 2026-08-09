import { Express } from 'express';
import { router as authRouter } from './auth.routes';

import { router as usersRouter } from './users.routes';
import { router as branchesRouter } from './branches.routes';
import { router as branchLocationsRouter } from './branch-locations.routes';
import { router as productsRouter } from './products.routes';
import { router as packingMaterialsRouter } from './packing-materials.routes';
import { router as priceRouter } from './price-management.routes';
import { router as customersRouter } from './customers.routes';
import { router as ordersRouter } from './orders.routes';
import { router as productionRouter } from './production.routes';
import { router as productionOrdersRouter } from './production-orders.routes';
import { router as productionStockRouter } from './production-stock.routes';
import { router as productionReturnsRouter } from './production-returns.routes';
import { router as productionExpensesRouter } from './production-expenses.routes';
import { router as productionReportsRouter } from './production-reports.routes';
import { router as expensesRouter } from './expenses.routes';
import { router as stockRouter } from './stock.routes';
import { router as reportsRouter } from './reports.routes';
import { router as searchRouter } from './search.routes';
import { router as supportRouter } from './support.routes';
import { router as closingNotificationsRouter } from './closing-notifications.routes';
import { router as specialEventsRouter } from './special-events.routes';
import { router as settingsRouter } from './settings.routes';
import { router as businessDayRouter } from './business-day.routes';
import { router as financeRouter } from './finance.routes';
import { router as financeIncomeRouter, entriesRouter as financeEntriesRouter } from './finance-income.routes';
import { router as financePayrollRouter } from './finance-payroll.routes';
import { router as financePartnersRouter } from './finance-partners.routes';
import { router as financeBranchShareRouter } from './finance-branch-share.routes';
import { router as financeReportsRouter } from './finance-reports.routes';

export function setupRoutes(app: Express) {
  app.use('/api/auth', authRouter);

  app.use('/api/users', usersRouter);
  app.use('/api/branches', branchesRouter);
  // Its own prefix rather than a sub-path of /api/branches: the admin module lists
  // and edits geofences as a resource in their own right, and a location is
  // deliberately not part of a branch record (see migration 48).
  app.use('/api/branch-locations', branchLocationsRouter);
  // Register the specific price prefix before the products router so it wins the match.
  app.use('/api/products/price', priceRouter);
  app.use('/api/products', productsRouter);
  // Its own prefix, not a sub-path of products: packing materials are service
  // items with no price, deliberately kept out of the product tables entirely.
  app.use('/api/packing-materials', packingMaterialsRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/production', productionRouter);
  app.use('/api/production-orders', productionOrdersRouter);
  app.use('/api/production-stock', productionStockRouter);
  app.use('/api/production-returns', productionReturnsRouter);
  app.use('/api/production-expenses', productionExpensesRouter);
  app.use('/api/production-reports', productionReportsRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/support', supportRouter);
  app.use('/api/closing-notifications', closingNotificationsRouter);
  app.use('/api/special-events', specialEventsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/business-day', businessDayRouter);

  // ── Finance Ledger ──
  // PREFIX ORDER MATTERS here exactly as it does for /api/products/price above:
  // Express matches mounts in registration order, and `/api/finance` would
  // swallow every one of the four specific prefixes below if it came first. The
  // symptom would be a 404 from the general router rather than an obvious
  // routing error, so keep the general mount LAST.
  app.use('/api/finance/income/entries', financeEntriesRouter);
  app.use('/api/finance/income', financeIncomeRouter);
  app.use('/api/finance/payroll', financePayrollRouter);
  app.use('/api/finance/partner-expenses', financePartnersRouter);
  app.use('/api/finance/branch-share', financeBranchShareRouter);
  app.use('/api/finance/reports', financeReportsRouter);
  app.use('/api/finance', financeRouter);
}
