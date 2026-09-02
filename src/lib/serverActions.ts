import { 
  Product, 
  Category,
  TaxCategory,
  CurrencyConfig,
  CustomerAccount,
  CustomerAddress,
  Order, 
  OrderStatus,
  InventoryLedgerEntry, 
  PaymentGatewayConfig, 
  ReconciliationLog, 
  DashboardAnalytics, 
  TransactionRecord,
  UserSession 
} from '../types/index.js';

const API_BASE = '/api';

// Helper to get BFF token from local state
function getAuthHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('omni_bff_token') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'x-bff-token': token } : {})
  };
}

// ============================================================================
// Server Actions simulation (Async functions returning raw promises for Suspense)
// ============================================================================

export async function fetchCategoriesAction(): Promise<Category[]> {
  const res = await fetch(`${API_BASE}/categories`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load categories');
  const data = await res.json();
  return data.categories;
}

export async function createCategoryAction(categoryData: Partial<Category>): Promise<Category> {
  const res = await fetch(`${API_BASE}/categories`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(categoryData)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create category');
  return data.category;
}

export async function updateCategoryAction(id: string, updates: Partial<Category>): Promise<Category> {
  const res = await fetch(`${API_BASE}/categories/${id}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update category');
  return data.category;
}

export async function deleteCategoryAction(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/categories/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  return !!data.success;
}

// ============================================================================
// Tax Management Server Actions
// ============================================================================

export async function fetchTaxCategoriesAction(): Promise<TaxCategory[]> {
  const res = await fetch(`${API_BASE}/taxes`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load tax categories');
  const data = await res.json();
  return data.taxCategories;
}

export async function createTaxCategoryAction(taxData: Partial<TaxCategory>): Promise<TaxCategory> {
  const res = await fetch(`${API_BASE}/taxes`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(taxData)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create tax category');
  return data.taxCategory;
}

export async function updateTaxCategoryAction(id: string, updates: Partial<TaxCategory>): Promise<TaxCategory> {
  const res = await fetch(`${API_BASE}/taxes/${id}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update tax category');
  return data.taxCategory;
}

export async function deleteTaxCategoryAction(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/taxes/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete tax category');
  return !!data.success;
}

export async function setDefaultTaxCategoryAction(id: string): Promise<TaxCategory> {
  const res = await fetch(`${API_BASE}/taxes/${id}/set-default`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to set default tax category');
  return data.taxCategory;
}

// ============================================================================
// Currency Management Server Actions
// ============================================================================

export async function fetchCurrenciesAction(): Promise<CurrencyConfig[]> {
  const res = await fetch(`${API_BASE}/currencies`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load currencies');
  const data = await res.json();
  return data.currencies;
}

export async function createCurrencyAction(currencyData: Partial<CurrencyConfig>): Promise<CurrencyConfig> {
  const res = await fetch(`${API_BASE}/currencies`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(currencyData)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create currency');
  return data.currency;
}

export async function updateCurrencyAction(code: string, updates: Partial<CurrencyConfig>): Promise<CurrencyConfig> {
  const res = await fetch(`${API_BASE}/currencies/${code}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update currency');
  return data.currency;
}

export async function deleteCurrencyAction(code: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/currencies/${code}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete currency');
  return !!data.success;
}

export async function setBaseCurrencyAction(code: string): Promise<CurrencyConfig> {
  const res = await fetch(`${API_BASE}/currencies/${code}/set-base`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to set base currency');
  return data.currency;
}

export async function fetchProductsAction(): Promise<Product[]> {
  const res = await fetch(`${API_BASE}/products`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load products');
  const data = await res.json();
  return data.products;
}

export async function fetchInventoryLedgerAction(limit = 150): Promise<InventoryLedgerEntry[]> {
  const res = await fetch(`${API_BASE}/inventory/ledger?limit=${limit}`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load inventory audit ledger');
  const data = await res.json();
  return data.ledger;
}

export async function fetchPaymentGatewaysAction(): Promise<PaymentGatewayConfig[]> {
  const res = await fetch(`${API_BASE}/admin/payment-gateways`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load payment gateways');
  const data = await res.json();
  return data.gateways;
}

export const fetchGatewaysAction = fetchPaymentGatewaysAction;

export async function fetchOrdersAction(): Promise<Order[]> {
  const res = await fetch(`${API_BASE}/orders`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load orders');
  const data = await res.json();
  return data.orders;
}

export async function fetchTransactionsAction(): Promise<TransactionRecord[]> {
  const res = await fetch(`${API_BASE}/transactions`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load transactions');
  const data = await res.json();
  return data.transactions;
}

export async function fetchReconciliationLogsAction(): Promise<ReconciliationLog[]> {
  const res = await fetch(`${API_BASE}/reconciliation/logs`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load reconciliation logs');
  const data = await res.json();
  return data.logs;
}

export async function fetchDashboardAnalyticsAction(): Promise<DashboardAnalytics> {
  const res = await fetch(`${API_BASE}/analytics/dashboard`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load dashboard analytics');
  const data = await res.json();
  return data.analytics;
}

export const fetchAnalyticsAction = fetchDashboardAnalyticsAction;

export async function fetchUserProfilesAction(): Promise<CustomerAccount[]> {
  const res = await fetch(`${API_BASE}/customers`, { headers: getAuthHeaders() });
  if (!res.ok) {
    const fallbackRes = await fetch(`${API_BASE}/users`, { headers: getAuthHeaders() });
    if (!fallbackRes.ok) return [];
    const fallbackData = await fallbackRes.json();
    return fallbackData.users || [];
  }
  const data = await res.json();
  return data.customers || [];
}

export const fetchAllCustomersAction = fetchUserProfilesAction;

export async function fetchCustomerAccountAction(customerId?: string): Promise<{ customer: CustomerAccount; orders: Order[] }> {
  const url = customerId ? `${API_BASE}/customers/${customerId}` : `${API_BASE}/customers/me`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load customer account details');
  const data = await res.json();
  return { customer: data.customer, orders: data.orders || [] };
}

export async function updateCustomerProfileAction(customerId: string, updates: Partial<CustomerAccount>): Promise<CustomerAccount> {
  const res = await fetch(`${API_BASE}/customers/${customerId}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update profile');
  return data.customer;
}

export async function addCustomerAddressAction(customerId: string, addressData: Omit<CustomerAddress, 'id'>): Promise<{ address: CustomerAddress; customer: CustomerAccount }> {
  const res = await fetch(`${API_BASE}/customers/${customerId}/addresses`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(addressData)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add address');
  return { address: data.address, customer: data.customer };
}

export async function updateCustomerAddressAction(customerId: string, addressId: string, updates: Partial<CustomerAddress>): Promise<{ address: CustomerAddress; customer: CustomerAccount }> {
  const res = await fetch(`${API_BASE}/customers/${customerId}/addresses/${addressId}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update address');
  return { address: data.address, customer: data.customer };
}

export async function deleteCustomerAddressAction(customerId: string, addressId: string): Promise<{ success: boolean; customer: CustomerAccount }> {
  const res = await fetch(`${API_BASE}/customers/${customerId}/addresses/${addressId}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete address');
  return { success: data.success, customer: data.customer };
}

export async function setDefaultAddressAction(customerId: string, addressId: string): Promise<CustomerAccount> {
  const res = await fetch(`${API_BASE}/customers/${customerId}/addresses/${addressId}/default`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to set default address');
  return data.customer;
}

export async function customerLoginAction(identifier: string, name?: string, phone?: string): Promise<{ session: UserSession; customer: CustomerAccount }> {
  const res = await fetch(`${API_BASE}/auth/customer-login`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ identifier, name, phone })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Login failed');
  if (data.session?.token && typeof window !== 'undefined') {
    localStorage.setItem('omni_bff_token', data.session.token);
  }
  return { session: data.session, customer: data.customer };
}

export async function fetchCustomerOrdersAction(customerId: string): Promise<Order[]> {
  const res = await fetch(`${API_BASE}/customers/${customerId}/orders`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load orders');
  const data = await res.json();
  return data.orders || [];
}

export async function fetchSessionAction(): Promise<UserSession> {
  const res = await fetch(`${API_BASE}/auth/session`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to load user session');
  const data = await res.json();
  if (data.session?.token && typeof window !== 'undefined') {
    localStorage.setItem('omni_bff_token', data.session.token);
  }
  return data.session;
}

// ============================================================================
// Mutation Server Actions
// ============================================================================

export async function switchUserRoleAction(role: 'admin' | 'customer', name?: string, email?: string): Promise<UserSession> {
  const res = await fetch(`${API_BASE}/auth/switch-role`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ role, name, email })
  });
  if (!res.ok) throw new Error('Failed to switch user role');
  const data = await res.json();
  if (data.session?.token && typeof window !== 'undefined') {
    localStorage.setItem('omni_bff_token', data.session.token);
  }
  return data.session;
}

export async function createCheckoutOrderAction(orderPayload: any): Promise<Order> {
  const res = await fetch(`${API_BASE}/orders/checkout`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(orderPayload)
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Checkout order creation failed');
  }
  return data.order;
}

export const createOrderAction = createCheckoutOrderAction;

export async function initiateDarajaStkAction(
  orderIdOrParams: string | { orderId: string; phoneNumber: string; amount?: number },
  phoneNumber?: string,
  amount?: number
): Promise<any> {
  const payload = typeof orderIdOrParams === 'string'
    ? { orderId: orderIdOrParams, phoneNumber: phoneNumber || '', amount: amount || 0 }
    : orderIdOrParams;

  const res = await fetch(`${API_BASE}/payments/daraja/stk-push`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to initiate M-Pesa STK Push');
  }
  return data.data;
}

export async function simulateDarajaUserAction(checkoutRequestId: string, action: 'accept' | 'cancel' | 'wrong_pin' | 'timeout'): Promise<any> {
  const res = await fetch(`${API_BASE}/payments/daraja/simulate-action`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ checkoutRequestId, action })
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Simulation failed');
  }
  return data.result;
}

export async function submitPesapalOrderAction(
  orderIdOrParams: string | { orderId: string; amount?: number; currency?: 'KES' | 'USD'; description?: string },
  amount?: number
): Promise<any> {
  const payload = typeof orderIdOrParams === 'string'
    ? { orderId: orderIdOrParams, amount: amount || 0, currency: 'KES' }
    : orderIdOrParams;

  const res = await fetch(`${API_BASE}/payments/pesapal/submit-order`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to initialize Pesapal checkout');
  }
  return data.data;
}

export const initiatePesapalPaymentAction = submitPesapalOrderAction;

export async function simulatePesapalPaymentAction(orderTrackingId: string, success: boolean, paymentChannel?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/payments/pesapal/simulate-payment`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ orderTrackingId, success, paymentChannel })
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to simulate Pesapal payment');
  }
  return data.result;
}

export async function updateProductStockAction(productId: string, newQuantity: number, reason: string): Promise<Product> {
  const res = await fetch(`${API_BASE}/inventory/adjust`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ productId, newQuantity, reason, actor: 'admin_dashboard' })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Stock adjustment failed');
  return data.product;
}

export async function createProductAction(productData: any): Promise<Product> {
  const res = await fetch(`${API_BASE}/products`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(productData)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Product creation failed');
  return data.product;
}

export async function updateProductAction(id: string, productData: any): Promise<Product> {
  const res = await fetch(`${API_BASE}/products/${id}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(productData)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Product update failed');
  return data.product;
}

export async function deleteProductAction(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/products/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  return !!data.success;
}

export async function updateGatewayConfigAction(gatewayId: string, updates: Partial<PaymentGatewayConfig>): Promise<PaymentGatewayConfig> {
  const res = await fetch(`${API_BASE}/admin/payment-gateways/${gatewayId}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Gateway config update failed');
  return data.gateway;
}

export async function runBatchReconciliationAction(): Promise<any> {
  const res = await fetch(`${API_BASE}/reconciliation/run-batch`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  return data.result;
}

export async function resolveDiscrepancyAction(logId: string, action: 'force_match' | 'mark_refund_required' | 'cancel_order', notes: string): Promise<any> {
  const res = await fetch(`${API_BASE}/reconciliation/resolve`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ logId, action, notes })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Discrepancy resolution failed');
  return data.log;
}

// Enterprise Inventory Stock Actions
export async function receiveStockAction(payload: {
  productId: string;
  quantity: number;
  supplier: string;
  poNumber: string;
  unitCost?: number;
  notes?: string;
}): Promise<Product> {
  const res = await fetch(`${API_BASE}/inventory/receive`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ ...payload, actor: 'admin' })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Stock receiving failed');
  return data.product;
}

export async function writeOffStockAction(payload: {
  productId: string;
  quantity: number;
  reasonCode: 'damage_transit' | 'defective_return' | 'warehouse_damage' | 'shrinkage_loss' | 'sample_marketing';
  notes?: string;
}): Promise<Product> {
  const res = await fetch(`${API_BASE}/inventory/write-off`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ ...payload, actor: 'admin' })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Stock write-off failed');
  return data.product;
}

export async function auditStockCountAction(payload: {
  productId: string;
  countedQuantity: number;
  notes?: string;
}): Promise<{ product: Product; discrepancy: number }> {
  const res = await fetch(`${API_BASE}/inventory/audit`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ ...payload, actor: 'admin_audit' })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Stock audit failed');
  return { product: data.product, discrepancy: data.discrepancy };
}

export async function batchAdjustStockAction(adjustments: { productId: string; newQuantity: number; reason: string }[]): Promise<Product[]> {
  const res = await fetch(`${API_BASE}/inventory/batch-adjust`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ adjustments, actor: 'admin' })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Batch adjustment failed');
  return data.products;
}

// Order Management Actions
export async function updateOrderStatusAction(
  orderId: string, 
  payload: {
    status: OrderStatus;
    shippingCourier?: string;
    trackingNumber?: string;
    internalNotes?: string;
  }
): Promise<Order> {
  const res = await fetch(`${API_BASE}/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Order status update failed');
  return data.order;
}

export async function cancelOrderAction(orderId: string, reason: string): Promise<Order> {
  const res = await fetch(`${API_BASE}/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ reason, actor: 'admin' })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Order cancellation failed');
  return data.order;
}

