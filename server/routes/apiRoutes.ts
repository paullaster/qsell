import { Router, Request, Response } from 'express';
import { db } from '../db/postgresStore.js';
import { InventoryService } from '../modules/inventory/inventoryService.js';
import { CategoryService } from '../modules/categories/categoryService.js';
import { TaxService } from '../modules/taxes/taxService.js';
import { CurrencyService } from '../modules/currencies/currencyService.js';
import { DarajaService } from '../modules/payments/mpesa/darajaService.js';
import { PesapalService } from '../modules/payments/pesapal/pesapalService.js';
import { ReconciliationEngine } from '../modules/reconciliation/reconciliationEngine.js';
import { AdminService } from '../modules/admin/adminService.js';
import { AnalyticsService } from '../modules/analytics/analyticsService.js';
import { SessionManager } from '../modules/bff/sessionManager.js';

export const apiRouter = Router();

// ==========================================
// 1. Server-Sent Events (SSE) for Real-Time Sync
// ==========================================
apiRouter.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);

  const unsubscribe = db.subscribeSSE((event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// ==========================================
// 2. Auth & Session Management (BFF)
// ==========================================
apiRouter.get('/auth/session', (req: Request, res: Response) => {
  const token = (req.headers['x-bff-token'] as string) || (req.headers.authorization?.replace('Bearer ', ''));
  let session = SessionManager.getSession(token);

  if (!session) {
    // Default initial session as customer or admin toggleable
    session = SessionManager.createSession('customer', 'paullasterokoth98@gmail.com', 'Paul Laster Okoth', '0712345678');
  }

  const customer = db.getCustomerById(session.userId) || db.getCustomerByEmailOrPhone(session.email);

  res.json({ success: true, session, customer });
});

apiRouter.post('/auth/switch-role', (req: Request, res: Response) => {
  const { role, name, email, phone } = req.body;
  const targetRole = role === 'admin' ? 'admin' : 'customer';
  const targetName = name || (targetRole === 'admin' ? 'Admin Paul' : 'Paul Laster Okoth');
  const targetEmail = email || (targetRole === 'admin' ? 'admin@omnicommerce.ke' : 'paullasterokoth98@gmail.com');
  const targetPhone = phone || (targetRole === 'admin' ? '0700000000' : '0712345678');

  const session = SessionManager.createSession(targetRole, targetEmail, targetName, targetPhone);
  const customer = targetRole === 'customer' 
    ? (db.getCustomerById(session.userId) || db.getCustomerByEmailOrPhone(targetEmail))
    : null;

  res.json({ success: true, session, customer });
});

apiRouter.post('/auth/customer-login', (req: Request, res: Response) => {
  const { identifier, name, phone } = req.body; // email or phone or id
  if (!identifier) {
    return res.status(400).json({ success: false, error: 'Email, phone, or Customer ID is required.' });
  }

  let customer = db.getCustomerByEmailOrPhone(identifier) || db.getCustomerById(identifier);
  if (!customer) {
    // Auto-create customer if logging in for first time with new credentials
    const isEmail = identifier.includes('@');
    customer = db.createCustomer({
      name: name || (isEmail ? identifier.split('@')[0] : 'Kenyan Shopper'),
      email: isEmail ? identifier : `cust_${Date.now()}@omnicommerce.ke`,
      phone: !isEmail ? identifier : (phone || '0700000000'),
      role: 'customer',
      status: 'verified'
    });
  }

  const session = SessionManager.createSession('customer', customer.email, customer.name, customer.phone);
  res.json({ success: true, session, customer });
});

// ==========================================
// 2.1 Customer Accounts & Address Book API
// ==========================================
apiRouter.get('/customers', (req: Request, res: Response) => {
  const customers = db.getAllCustomers();
  res.json({ success: true, customers });
});

// Backward compatibility for AdminAnalytics /users
apiRouter.get('/users', (req: Request, res: Response) => {
  const customers = db.getAllCustomers();
  res.json({ success: true, users: customers });
});

apiRouter.get('/customers/me', (req: Request, res: Response) => {
  const token = (req.headers['x-bff-token'] as string) || (req.headers.authorization?.replace('Bearer ', ''));
  const session = SessionManager.getSession(token);
  const customerId = (req.query.customerId as string) || session?.userId || 'usr_paullaster';

  const customer = db.getCustomerById(customerId) || db.getCustomerByEmailOrPhone('paullasterokoth98@gmail.com');
  if (!customer) {
    return res.status(404).json({ success: false, error: 'Customer not found' });
  }
  const orders = db.getCustomerOrders(customer.id);
  res.json({ success: true, customer, orders });
});

apiRouter.get('/customers/:id', (req: Request, res: Response) => {
  const customer = db.getCustomerById(req.params.id) || db.getCustomerByEmailOrPhone(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, error: 'Customer account not found' });
  }
  const orders = db.getCustomerOrders(customer.id);
  res.json({ success: true, customer, orders });
});

apiRouter.post('/customers', (req: Request, res: Response) => {
  try {
    const customer = db.createCustomer(req.body);
    res.status(201).json({ success: true, customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/customers/:id', (req: Request, res: Response) => {
  try {
    const customer = db.updateCustomer(req.params.id, req.body);
    res.json({ success: true, customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.get('/customers/:id/orders', (req: Request, res: Response) => {
  const orders = db.getCustomerOrders(req.params.id);
  res.json({ success: true, orders });
});

apiRouter.post('/customers/:id/addresses', (req: Request, res: Response) => {
  try {
    const address = db.addCustomerAddress(req.params.id, req.body);
    const customer = db.getCustomerById(req.params.id);
    res.status(201).json({ success: true, address, customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/customers/:id/addresses/:addressId', (req: Request, res: Response) => {
  try {
    const address = db.updateCustomerAddress(req.params.id, req.params.addressId, req.body);
    const customer = db.getCustomerById(req.params.id);
    res.json({ success: true, address, customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/customers/:id/addresses/:addressId', (req: Request, res: Response) => {
  try {
    const success = db.deleteCustomerAddress(req.params.id, req.params.addressId);
    const customer = db.getCustomerById(req.params.id);
    res.json({ success, customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/customers/:id/addresses/:addressId/default', (req: Request, res: Response) => {
  try {
    const customer = db.setDefaultAddress(req.params.id, req.params.addressId);
    res.json({ success: true, customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. Category Management (Full CRUD)
// ==========================================
apiRouter.get('/categories', (req: Request, res: Response) => {
  const categories = CategoryService.getAllCategories();
  res.json({ success: true, categories });
});

apiRouter.get('/categories/:id', (req: Request, res: Response) => {
  const category = CategoryService.getCategoryById(req.params.id);
  if (!category) {
    return res.status(404).json({ success: false, error: 'Category not found' });
  }
  res.json({ success: true, category });
});

apiRouter.post('/categories', (req: Request, res: Response) => {
  try {
    const category = CategoryService.createCategory(req.body);
    res.status(201).json({ success: true, category });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/categories/:id', (req: Request, res: Response) => {
  try {
    const category = CategoryService.updateCategory(req.params.id, req.body);
    res.json({ success: true, category });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/categories/:id', (req: Request, res: Response) => {
  const deleted = CategoryService.deleteCategory(req.params.id);
  res.json({ success: deleted });
});

// ==========================================
// 3.1 Tax Management & Rules (Full CRUD)
// ==========================================
apiRouter.get('/taxes', (req: Request, res: Response) => {
  const taxCategories = TaxService.getAllTaxCategories();
  res.json({ success: true, taxCategories });
});

apiRouter.get('/taxes/:id', (req: Request, res: Response) => {
  const tax = TaxService.getTaxCategoryById(req.params.id);
  if (!tax) {
    return res.status(404).json({ success: false, error: 'Tax category not found' });
  }
  res.json({ success: true, taxCategory: tax });
});

apiRouter.post('/taxes', (req: Request, res: Response) => {
  try {
    const taxCategory = TaxService.createTaxCategory(req.body);
    res.status(201).json({ success: true, taxCategory });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/taxes/:id', (req: Request, res: Response) => {
  try {
    const taxCategory = TaxService.updateTaxCategory(req.params.id, req.body);
    res.json({ success: true, taxCategory });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/taxes/:id', (req: Request, res: Response) => {
  try {
    const deleted = TaxService.deleteTaxCategory(req.params.id);
    res.json({ success: deleted });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/taxes/:id/set-default', (req: Request, res: Response) => {
  try {
    const taxCategory = TaxService.setDefaultTaxCategory(req.params.id);
    res.json({ success: true, taxCategory });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3.2 Currency Management (Multi-Market CRUD)
// ==========================================
apiRouter.get('/currencies', (req: Request, res: Response) => {
  const currencies = CurrencyService.getAllCurrencies();
  res.json({ success: true, currencies });
});

apiRouter.get('/currencies/:code', (req: Request, res: Response) => {
  const currency = CurrencyService.getCurrencyByCode(req.params.code);
  if (!currency) {
    return res.status(404).json({ success: false, error: 'Currency not found' });
  }
  res.json({ success: true, currency });
});

apiRouter.post('/currencies', (req: Request, res: Response) => {
  try {
    const currency = CurrencyService.createCurrency(req.body);
    res.status(201).json({ success: true, currency });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/currencies/:code', (req: Request, res: Response) => {
  try {
    const currency = CurrencyService.updateCurrency(req.params.code, req.body);
    res.json({ success: true, currency });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/currencies/:code', (req: Request, res: Response) => {
  try {
    const deleted = CurrencyService.deleteCurrency(req.params.code);
    res.json({ success: deleted });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/currencies/:code/set-base', (req: Request, res: Response) => {
  try {
    const currency = CurrencyService.setBaseCurrency(req.params.code);
    res.json({ success: true, currency });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. Products Catalog & Inventory
// ==========================================
apiRouter.get('/products', (req: Request, res: Response) => {
  const products = InventoryService.getAllProducts();
  res.json({ success: true, products });
});

apiRouter.get('/products/:id', (req: Request, res: Response) => {
  const product = InventoryService.getProductById(req.params.id) || InventoryService.getProductBySlug(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }
  res.json({ success: true, product });
});

apiRouter.post('/products', (req: Request, res: Response) => {
  try {
    const product = InventoryService.createProduct(req.body);
    res.status(201).json({ success: true, product });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/products/:id', (req: Request, res: Response) => {
  try {
    const product = InventoryService.updateProduct(req.params.id, req.body);
    res.json({ success: true, product });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/products/:id', (req: Request, res: Response) => {
  const deleted = InventoryService.deleteProduct(req.params.id);
  res.json({ success: deleted });
});

// Inventory Operations
apiRouter.get('/inventory/ledger', (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 150;
  const ledger = InventoryService.getInventoryLedger(limit);
  res.json({ success: true, ledger });
});

apiRouter.get('/inventory/low-stock', (req: Request, res: Response) => {
  const lowStock = InventoryService.getLowStockProducts();
  res.json({ success: true, count: lowStock.length, products: lowStock });
});

apiRouter.post('/inventory/adjust', (req: Request, res: Response) => {
  try {
    const { productId, newQuantity, reason, actor } = req.body;
    const product = InventoryService.updateStock(productId, Number(newQuantity), reason, actor || 'admin');
    res.json({ success: true, product });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Stock In / PO Receiving
apiRouter.post('/inventory/receive', (req: Request, res: Response) => {
  try {
    const { productId, quantity, supplier, poNumber, unitCost, notes, actor } = req.body;
    const product = db.receiveStock(productId, Number(quantity), supplier, poNumber, unitCost ? Number(unitCost) : undefined, notes, actor || 'admin');
    res.json({ success: true, product });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Stock Out / Damage Write-Off
apiRouter.post('/inventory/write-off', (req: Request, res: Response) => {
  try {
    const { productId, quantity, reasonCode, notes, actor } = req.body;
    const product = db.writeOffStock(productId, Number(quantity), reasonCode, notes, actor || 'admin');
    res.json({ success: true, product });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Physical Stock Count Audit
apiRouter.post('/inventory/audit', (req: Request, res: Response) => {
  try {
    const { productId, countedQuantity, notes, actor } = req.body;
    const result = db.physicalStockAudit(productId, Number(countedQuantity), notes, actor || 'inventory_auditor');
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Batch Stock Adjust
apiRouter.post('/inventory/batch-adjust', (req: Request, res: Response) => {
  try {
    const { adjustments, actor } = req.body;
    const products = db.batchStockAdjust(adjustments || [], actor || 'admin');
    res.json({ success: true, products });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. Orders & Checkout (BFF)
// ==========================================
apiRouter.get('/orders', (req: Request, res: Response) => {
  const orders = AdminService.getAllOrders();
  res.json({ success: true, orders });
});

apiRouter.get('/orders/:id', (req: Request, res: Response) => {
  const order = db.orders.get(req.params.id) || Array.from(db.orders.values()).find(o => o.orderNumber === req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }
  res.json({ success: true, order });
});

apiRouter.post('/orders/checkout', (req: Request, res: Response) => {
  try {
    const result = SessionManager.createOrder(req.body);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.status(201).json({ success: true, order: result.order });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/orders/:id/status', (req: Request, res: Response) => {
  try {
    const { status, shippingCourier, trackingNumber, internalNotes } = req.body;
    const order = db.updateOrderStatus(req.params.id, status, shippingCourier, trackingNumber, internalNotes);
    res.json({ success: true, order });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/orders/:id/cancel', (req: Request, res: Response) => {
  try {
    const { reason, actor } = req.body;
    const order = db.cancelOrderAndRestock(req.params.id, reason, actor || 'admin');
    res.json({ success: true, order });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. M-Pesa Daraja Integration
// ==========================================
apiRouter.post('/payments/daraja/stk-push', async (req: Request, res: Response) => {
  try {
    const response = await DarajaService.initiateStkPush(req.body);
    res.json({ success: true, data: response });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/payments/daraja/simulate-action', async (req: Request, res: Response) => {
  try {
    const { checkoutRequestId, action } = req.body;
    const result = await DarajaService.simulateUserStkAction(checkoutRequestId, action);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/payments/daraja/callback', async (req: Request, res: Response) => {
  try {
    const result = await DarajaService.processCallback(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 6. Pesapal v3 Integration
// ==========================================
apiRouter.post('/payments/pesapal/submit-order', async (req: Request, res: Response) => {
  try {
    const response = await PesapalService.submitOrder(req.body);
    res.json({ success: true, data: response });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/payments/pesapal/simulate-payment', async (req: Request, res: Response) => {
  try {
    const { orderTrackingId, success, paymentChannel } = req.body;
    const result = await PesapalService.simulatePesapalPayment(orderTrackingId, success, paymentChannel);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.all('/payments/pesapal/ipn', async (req: Request, res: Response) => {
  const orderTrackingId = req.query.OrderTrackingId || req.body?.OrderTrackingId || req.body?.orderTrackingId;
  const merchantReference = req.query.OrderMerchantReference || req.body?.OrderMerchantReference || req.body?.merchantReference;
  const status = req.query.status || req.body?.status || 'COMPLETED';

  const result = await PesapalService.processIpn(String(orderTrackingId), String(merchantReference), String(status));
  res.json(result);
});

// ==========================================
// 7. Payment Gateway Configuration (Admin)
// ==========================================
apiRouter.get('/admin/payment-gateways', (req: Request, res: Response) => {
  const gateways = AdminService.getPaymentGateways();
  res.json({ success: true, gateways });
});

apiRouter.patch('/admin/payment-gateways/:id', (req: Request, res: Response) => {
  try {
    const updated = AdminService.updatePaymentGateway(req.params.id, req.body);
    res.json({ success: true, gateway: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 8. Reconciliation Engine & Transactions
// ==========================================
apiRouter.get('/reconciliation/logs', (req: Request, res: Response) => {
  const logs = ReconciliationEngine.getReconciliationLogs();
  res.json({ success: true, logs });
});

apiRouter.post('/reconciliation/run-batch', (req: Request, res: Response) => {
  const result = ReconciliationEngine.runBatchReconciliation();
  res.json({ success: true, result });
});

apiRouter.post('/reconciliation/resolve', (req: Request, res: Response) => {
  try {
    const { logId, action, notes } = req.body;
    const log = ReconciliationEngine.resolveDiscrepancy(logId, action, notes);
    res.json({ success: true, log });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.get('/transactions', (req: Request, res: Response) => {
  const transactions = AdminService.getAllTransactions();
  res.json({ success: true, transactions });
});

// ==========================================
// 9. Analytics & Reports
// ==========================================
apiRouter.get('/analytics/dashboard', (req: Request, res: Response) => {
  const analytics = AnalyticsService.getDashboardAnalytics();
  res.json({ success: true, analytics });
});

apiRouter.get('/analytics/user/:id', (req: Request, res: Response) => {
  const analytics = AnalyticsService.getUserAnalytics(req.params.id);
  res.json({ success: true, analytics });
});
