/**
 * Domain action barrel — re-exports all server actions for UI imports.
 * Prefer importing from domain modules directly in new code.
 * Do not add "use server" here: re-exports are invalid in use-server files.
 */

export {
  listProductsAction,
  getProductAction,
  createProductAction,
  updateProductAction,
  deleteProductAction,
  listCategoriesAction,
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
} from '@/server/domains/catalog/actions';

export {
  listTaxCategoriesAction,
  createTaxCategoryAction,
  updateTaxCategoryAction,
  deleteTaxCategoryAction,
  setDefaultTaxCategoryAction,
} from '@/server/domains/taxes/actions';

export {
  listCurrenciesAction,
  createCurrencyAction,
  updateCurrencyAction,
  deleteCurrencyAction,
  setBaseCurrencyAction,
} from '@/server/domains/currencies/actions';

export {
  listInventoryLedgerAction,
  listLowStockAction,
  adjustStockAction,
  updateProductStockAction,
  receiveStockAction,
  writeOffStockAction,
  auditStockCountAction,
  batchAdjustStockAction,
  updateOrderStatusAction,
  cancelOrderAction,
} from '@/server/domains/inventory/actions';

export {
  listOrdersAction,
  getOrderAction,
  createOrderAction,
  createCheckoutOrderAction,
} from '@/server/domains/orders/actions';

export {
  listGatewaysAction,
  updateGatewayConfigAction,
  listTransactionsAction,
} from '@/server/domains/gateways/actions';

export {
  initiateDarajaStkAction,
  simulateDarajaUserAction,
  initiatePesapalPaymentAction,
  submitPesapalOrderAction,
  simulatePesapalPaymentAction,
} from '@/server/domains/payments/actions';

export {
  listReconciliationLogsAction,
  runBatchReconciliationAction,
  resolveDiscrepancyAction,
} from '@/server/domains/reconciliation/actions';

export {
  listAnalyticsAction,
  fetchAnalyticsAction,
  fetchDashboardAnalyticsAction,
  getUserAnalyticsAction,
} from '@/server/domains/analytics/actions';

export {
  getSessionAction,
  switchRoleAction,
  customerLoginAction,
  ensureAdminSessionAction,
} from '@/server/domains/auth/actions';

export {
  listCustomersAction,
  fetchUserProfilesAction,
  getCustomerAccountAction,
  updateCustomerProfileAction,
  addCustomerAddressAction,
  updateCustomerAddressAction,
  deleteCustomerAddressAction,
  setDefaultAddressAction,
  listCustomerOrdersAction,
} from '@/server/domains/customers/actions';

export { listCustomersAction as fetchAllCustomersAction } from '@/server/domains/customers/actions';

// Aliases matching previous client fetch wrappers
export { listProductsAction as fetchProductsAction } from '@/server/domains/catalog/actions';
export { listCategoriesAction as fetchCategoriesAction } from '@/server/domains/catalog/actions';
export { listTaxCategoriesAction as fetchTaxCategoriesAction } from '@/server/domains/taxes/actions';
export { listCurrenciesAction as fetchCurrenciesAction } from '@/server/domains/currencies/actions';
export { listGatewaysAction as fetchGatewaysAction } from '@/server/domains/gateways/actions';
export { listOrdersAction as fetchOrdersAction } from '@/server/domains/orders/actions';
export { listTransactionsAction as fetchTransactionsAction } from '@/server/domains/gateways/actions';
export { listReconciliationLogsAction as fetchReconciliationLogsAction } from '@/server/domains/reconciliation/actions';
export { listInventoryLedgerAction as fetchInventoryLedgerAction } from '@/server/domains/inventory/actions';
export { getCustomerAccountAction as fetchCustomerAccountAction } from '@/server/domains/customers/actions';
export { switchRoleAction as switchUserRoleAction } from '@/server/domains/auth/actions';
export { getSessionAction as fetchSessionAction } from '@/server/domains/auth/actions';

export {
  getCompanySettingsAction,
  updateCompanySettingsAction,
  uploadCompanyLogoAction,
} from '@/server/domains/company/actions';

export {
  generateInvoicePdfAction,
  emailInvoiceAction,
} from '@/server/domains/invoices/actions';

