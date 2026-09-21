import {
  type Product,
  type Category,
  type ItemType,
  type TaxCategory,
  type CurrencyConfig,
  type CustomerAccount,
  type CustomerAddress,
  type InventoryLedgerEntry,
  type PaymentGatewayConfig,
  type Order,
  type OrderStatus,
  type TransactionRecord,
  type ReconciliationLog,
  type UserSession,
} from '@/types/index';

// In-Memory Transactional Store with atomic operations
class PostgresStore {
  public categories = new Map<string, Category>();
  public itemTypes = new Map<string, ItemType>();
  public taxCategories = new Map<string, TaxCategory>();
  public currencies = new Map<string, CurrencyConfig>();
  public products = new Map<string, Product>();
  public inventoryLedger: InventoryLedgerEntry[] = [];
  public paymentGateways = new Map<string, PaymentGatewayConfig>();
  public orders = new Map<string, Order>();
  public transactions = new Map<string, TransactionRecord>();
  public reconciliationLogs: ReconciliationLog[] = [];
  public customers = new Map<string, CustomerAccount>();
  public userSessions = new Map<string, UserSession>();
  public sseClients = new Set<(event: string, data: any) => void>();

  constructor() {
    // Catalog, taxes, currencies, gateways, and customers start empty.
    // Super-admin is seeded separately via auth (env).
  }

  // Subscribe SSE clients for real-time inventory updates
  public subscribeSSE(client: (event: string, data: any) => void) {
    this.sseClients.add(client);
    return () => {
      this.sseClients.delete(client);
    };
  }

  public broadcast(event: string, data: any) {
    for (const send of this.sseClients) {
      try {
        send(event, data);
      } catch (err) {
        // ignore closed
      }
    }
  }

  // ==========================================================================
  // Customer Account & Address Book Operations
  // ==========================================================================
  public getAllCustomers(): CustomerAccount[] {
    return Array.from(this.customers.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  public getCustomerById(id: string): CustomerAccount | null {
    return this.customers.get(id) || null;
  }

  public getCustomerByEmailOrPhone(query: string): CustomerAccount | null {
    if (!query) return null;
    const clean = query.trim().toLowerCase();
    const phoneClean = query.replace(/\D/g, '');

    for (const cust of this.customers.values()) {
      if (cust.email.toLowerCase() === clean) return cust;
      if (cust.id.toLowerCase() === clean) return cust;
      const custPhone = cust.phone.replace(/\D/g, '');
      if (
        custPhone &&
        phoneClean &&
        (custPhone.includes(phoneClean) || phoneClean.includes(custPhone))
      ) {
        return cust;
      }
    }
    return null;
  }

  public createCustomer(data: Partial<CustomerAccount>): CustomerAccount {
    const id = data.id || `usr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();

    const customer: CustomerAccount = {
      id,
      name: data.name?.trim() || 'Customer',
      email: data.email?.trim() || '',
      phone: data.phone?.trim() || '',
      avatarUrl: data.avatarUrl,
      role: data.role || 'customer',
      status: data.status || 'verified',
      addresses: data.addresses || [],
      paymentPreferences: data.paymentPreferences || {},
      totalOrders: data.totalOrders || 0,
      totalSpend: data.totalSpend || 0,
      lastOrderDate: data.lastOrderDate,
      createdAt: now,
      updatedAt: now,
    };

    this.customers.set(id, customer);
    this.broadcast('customer_created', customer);
    return customer;
  }

  public updateCustomer(id: string, updates: Partial<CustomerAccount>): CustomerAccount {
    const customer = this.customers.get(id);
    if (!customer) {
      throw new Error(`Customer with ID ${id} not found`);
    }

    const updated: CustomerAccount = {
      ...customer,
      ...updates,
      paymentPreferences: {
        ...customer.paymentPreferences,
        ...(updates.paymentPreferences || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    this.customers.set(id, updated);
    this.broadcast('customer_updated', updated);
    return updated;
  }

  public addCustomerAddress(
    customerId: string,
    addressData: Omit<CustomerAddress, 'id'>,
  ): CustomerAddress {
    const customer = this.customers.get(customerId);
    if (!customer) {
      throw new Error(`Customer with ID ${customerId} not found`);
    }

    const addressId = `addr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const isFirst = customer.addresses.length === 0;
    const isDefault = addressData.isDefault || isFirst;

    if (isDefault) {
      customer.addresses.forEach((a) => {
        a.isDefault = false;
      });
    }

    const newAddress: CustomerAddress = {
      ...addressData,
      id: addressId,
      isDefault,
    };

    customer.addresses.push(newAddress);
    customer.updatedAt = new Date().toISOString();
    this.broadcast('customer_updated', customer);
    return newAddress;
  }

  public updateCustomerAddress(
    customerId: string,
    addressId: string,
    updates: Partial<CustomerAddress>,
  ): CustomerAddress {
    const customer = this.customers.get(customerId);
    if (!customer) {
      throw new Error(`Customer with ID ${customerId} not found`);
    }

    const idx = customer.addresses.findIndex((a) => a.id === addressId);
    if (idx === -1) {
      throw new Error(`Address ${addressId} not found for customer ${customerId}`);
    }

    if (updates.isDefault) {
      customer.addresses.forEach((a) => {
        a.isDefault = false;
      });
    }

    const existing = customer.addresses[idx];
    const updated: CustomerAddress = {
      ...existing,
      ...updates,
    };

    customer.addresses[idx] = updated;
    customer.updatedAt = new Date().toISOString();
    this.broadcast('customer_updated', customer);
    return updated;
  }

  public deleteCustomerAddress(customerId: string, addressId: string): boolean {
    const customer = this.customers.get(customerId);
    if (!customer) return false;

    const initialLen = customer.addresses.length;
    customer.addresses = customer.addresses.filter((a) => a.id !== addressId);

    if (customer.addresses.length < initialLen) {
      if (customer.addresses.length > 0 && !customer.addresses.some((a) => a.isDefault)) {
        customer.addresses[0].isDefault = true;
      }
      customer.updatedAt = new Date().toISOString();
      this.broadcast('customer_updated', customer);
      return true;
    }
    return false;
  }

  public setDefaultAddress(customerId: string, addressId: string): CustomerAccount {
    const customer = this.customers.get(customerId);
    if (!customer) {
      throw new Error(`Customer with ID ${customerId} not found`);
    }

    customer.addresses.forEach((a) => {
      a.isDefault = a.id === addressId;
    });

    customer.updatedAt = new Date().toISOString();
    this.broadcast('customer_updated', customer);
    return customer;
  }

  public getCustomerOrders(customerIdOrEmail: string): Order[] {
    const clean = customerIdOrEmail.toLowerCase().trim();
    return Array.from(this.orders.values())
      .filter(
        (o) =>
          (o.userId && o.userId.toLowerCase() === clean) ||
          (o.customerEmail && o.customerEmail.toLowerCase() === clean),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Transactional Atomic Inventory Reservation
  public atomicReserveStock(
    items: { productId: string; quantity: number }[],
    orderId: string,
    actor = 'customer_checkout',
  ): { success: boolean; error?: string } {
    // 1. Validate all items exist and have sufficient available stock (stockQuantity - reservedQuantity)
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product ID ${item.productId} was not found in catalog.` };
      }
      const available = prod.stockQuantity - prod.reservedQuantity;
      if (available < item.quantity) {
        return {
          success: false,
          error: `Insufficient inventory for "${prod.name}". Available: ${available}, Requested: ${item.quantity}.`,
        };
      }
    }

    // 2. Perform atomic reservation
    for (const item of items) {
      const prod = this.products.get(item.productId)!;
      prod.reservedQuantity += item.quantity;
      prod.updatedAt = new Date().toISOString();

      this.inventoryLedger.push({
        id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        productId: prod.id,
        productName: prod.name,
        changeAmount: -item.quantity,
        previousStock: prod.stockQuantity,
        newStock: prod.stockQuantity - prod.reservedQuantity,
        changeType: 'order_reservation',
        referenceId: orderId,
        actor,
        note: `Reserved ${item.quantity} units for pending order ${orderId}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Broadcast inventory change
    this.broadcast('inventory_update', {
      type: 'reservation',
      orderId,
      products: Array.from(this.products.values()),
    });

    return { success: true };
  }

  // Transactional Inventory Fulfillment on Payment Success
  public atomicFulfillStock(
    items: { productId: string; quantity: number }[],
    orderId: string,
  ): void {
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (prod) {
        const prevStock = prod.stockQuantity;
        prod.stockQuantity = Math.max(0, prod.stockQuantity - item.quantity);
        prod.reservedQuantity = Math.max(0, prod.reservedQuantity - item.quantity);
        prod.updatedAt = new Date().toISOString();

        this.inventoryLedger.push({
          id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          productId: prod.id,
          productName: prod.name,
          changeAmount: -item.quantity,
          previousStock: prevStock,
          newStock: prod.stockQuantity,
          changeType: 'order_fulfillment',
          referenceId: orderId,
          actor: 'payment_reconciliation_engine',
          note: `Fulfilled and finalized stock deduction of ${item.quantity} units for order ${orderId}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.broadcast('inventory_update', {
      type: 'fulfillment',
      orderId,
      products: Array.from(this.products.values()),
    });
  }

  // Release stock if payment fails or expires
  public atomicReleaseReservation(
    items: { productId: string; quantity: number }[],
    orderId: string,
  ): void {
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (prod) {
        prod.reservedQuantity = Math.max(0, prod.reservedQuantity - item.quantity);
        prod.updatedAt = new Date().toISOString();

        this.inventoryLedger.push({
          id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          productId: prod.id,
          productName: prod.name,
          changeAmount: item.quantity,
          previousStock: prod.stockQuantity,
          newStock: prod.stockQuantity,
          changeType: 'order_cancellation_release',
          referenceId: orderId,
          actor: 'system_timeout_releaser',
          note: `Released reservation of ${item.quantity} units due to order cancellation or timeout for ${orderId}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.broadcast('inventory_update', {
      type: 'release',
      orderId,
      products: Array.from(this.products.values()),
    });
  }

  private inventorySettled = new Set<string>();

  /** Present on instances created before this field existed (dev hot reload). */
  private settledOrderIds(): Set<string> {
    if (!(this.inventorySettled instanceof Set)) {
      this.inventorySettled = new Set();
    }
    return this.inventorySettled;
  }

  /** Drop a checkout reservation when payment never succeeds. Idempotent. */
  public releaseOrderReservation(orderId: string): void {
    const settled = this.settledOrderIds();
    if (settled.has(orderId)) return;
    const order = this.orders.get(orderId);
    if (!order) {
      settled.add(orderId);
      return;
    }
    const alreadyReleased = this.inventoryLedger.some(
      (entry) =>
        entry.referenceId === orderId &&
        (entry.changeType === 'order_cancellation_release' ||
          entry.changeType === 'order_fulfillment'),
    );
    if (!alreadyReleased && order.items.length > 0) {
      this.atomicReleaseReservation(
        order.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        orderId,
      );
    }
    settled.add(orderId);
  }

  /** Turn a reservation into a real stock deduction after payment succeeds. Idempotent. */
  public fulfillOrderReservation(orderId: string): void {
    const settled = this.settledOrderIds();
    if (settled.has(orderId)) return;
    const order = this.orders.get(orderId);
    if (!order) {
      settled.add(orderId);
      return;
    }
    const alreadyFulfilled = this.inventoryLedger.some(
      (entry) => entry.referenceId === orderId && entry.changeType === 'order_fulfillment',
    );
    if (!alreadyFulfilled && order.items.length > 0) {
      this.atomicFulfillStock(
        order.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        orderId,
      );
    }
    settled.add(orderId);
  }

  /**
   * Orders whose payment already failed still hold reserved units. Put that stock back.
   * Pending payments are left alone so an in-flight prompt still holds its quantity.
   */
  public releaseFailedPaymentReservations(): void {
    for (const order of this.orders.values()) {
      if (order.paymentMethod === 'on_account') continue;
      if (order.paymentStatus !== 'failed') continue;
      this.releaseOrderReservation(order.id);
    }
  }

  // ==========================================================================
  // Category Management CRUD
  // ==========================================================================
  public getAllCategories(): Category[] {
    const list = Array.from(this.categories.values()).sort(
      (a, b) => a.displayOrder - b.displayOrder,
    );
    // Count products per category
    return list.map((cat) => {
      const count = Array.from(this.products.values()).filter(
        (p) => p.category.toLowerCase() === cat.name.toLowerCase(),
      ).length;
      return { ...cat, productCount: count };
    });
  }

  public getCategoryById(id: string): Category | undefined {
    return this.categories.get(id);
  }

  public createCategory(
    data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): Category {
    const id = `cat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newCategory: Category = {
      ...data,
      id,
      slug: data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      displayOrder: data.displayOrder || this.categories.size + 1,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.categories.set(id, newCategory);
    this.broadcast('category_update', { type: 'created', category: newCategory });
    return newCategory;
  }

  public updateCategory(id: string, updates: Partial<Category>): Category {
    const existing = this.categories.get(id);
    if (!existing) throw new Error(`Category ${id} not found`);

    const previousName = existing.name;
    const updated: Category = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    };

    this.categories.set(id, updated);

    // Keep product.category in sync when the category is renamed.
    if (updates.name && updates.name !== previousName) {
      const now = new Date().toISOString();
      for (const prod of this.products.values()) {
        if (prod.category.toLowerCase() === previousName.toLowerCase()) {
          this.products.set(prod.id, {
            ...prod,
            category: updated.name,
            updatedAt: now,
          });
        }
      }
      this.broadcast('inventory_update', {
        type: 'products_reassigned',
        products: Array.from(this.products.values()),
      });
    }

    this.broadcast('category_update', { type: 'updated', category: updated });
    return updated;
  }

  public deleteCategory(id: string): {
    deleted: boolean;
    reassignedCount: number;
    fallbackName: string | null;
  } {
    const existing = this.categories.get(id);
    if (!existing) {
      throw new Error(`Category ${id} not found`);
    }

    const productsInCat = Array.from(this.products.values()).filter(
      (p) => p.category.toLowerCase() === existing.name.toLowerCase(),
    );

    let fallbackName: string | null = null;

    if (productsInCat.length > 0) {
      const others = Array.from(this.categories.values())
        .filter((c) => c.id !== id)
        .sort(
          (a, b) =>
            Number(b.isActive) - Number(a.isActive) || a.displayOrder - b.displayOrder,
        );

      // Prefer another real category. Never invent a hardcoded label.
      fallbackName = others[0]?.name ?? '';

      const now = new Date().toISOString();
      for (const prod of productsInCat) {
        this.products.set(prod.id, {
          ...prod,
          category: fallbackName,
          updatedAt: now,
        });
      }
    }

    const deleted = this.categories.delete(id);
    if (deleted) {
      this.broadcast('category_update', {
        type: 'deleted',
        categoryId: id,
        reassignedCount: productsInCat.length,
        fallbackName,
      });
      if (productsInCat.length > 0) {
        this.broadcast('inventory_update', {
          type: 'products_reassigned',
          products: Array.from(this.products.values()),
        });
      }
    }

    return {
      deleted,
      reassignedCount: productsInCat.length,
      fallbackName,
    };
  }

  // ==========================================================================
  // Item Type Management (raw material, finished good, … — user-defined)
  // ==========================================================================

  public getAllItemTypes(): ItemType[] {
    return Array.from(this.itemTypes.values())
      .sort((a, b) => a.code - b.code || a.name.localeCompare(b.name))
      .map((type) => ({
        ...type,
        productCount: Array.from(this.products.values()).filter((p) => p.itemTypeId === type.id)
          .length,
      }));
  }

  public getItemTypeById(id: string): ItemType | undefined {
    return this.itemTypes.get(id);
  }

  public getDefaultItemType(): ItemType | undefined {
    return Array.from(this.itemTypes.values()).find((t) => t.isDefault && t.isActive)
      || Array.from(this.itemTypes.values()).find((t) => t.isDefault)
      || Array.from(this.itemTypes.values())[0];
  }

  public createItemType(data: {
    name: string;
    code: number;
    isSellable: boolean;
    isDefault?: boolean;
    isActive?: boolean;
  }): ItemType {
    const name = data.name.trim();
    if (!name) throw new Error('Item type name is required');

    if (data.code === null || data.code === undefined || Number.isNaN(Number(data.code))) {
      throw new Error('Item type code is required (tax authority integer code)');
    }
    const code = Math.trunc(Number(data.code));
    if (!Number.isInteger(Number(data.code)) || !Number.isFinite(code) || code < 0) {
      throw new Error('Item type code must be a non-negative integer from the tax authority');
    }
    const clash = Array.from(this.itemTypes.values()).find((t) => t.code === code);
    if (clash) throw new Error(`Item type code ${code} is already in use`);

    const isFirst = this.itemTypes.size === 0;
    const makeDefault = isFirst || Boolean(data.isDefault);

    if (makeDefault) {
      for (const type of this.itemTypes.values()) {
        if (type.isDefault) {
          this.itemTypes.set(type.id, {
            ...type,
            isDefault: false,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    const id = `itype_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    const created: ItemType = {
      id,
      code,
      name,
      isSellable: Boolean(data.isSellable),
      isDefault: makeDefault,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
      createdAt: now,
      updatedAt: now,
    };
    this.itemTypes.set(id, created);
    this.broadcast('item_type_update', { type: 'created', itemType: created });
    return created;
  }

  public updateItemType(
    id: string,
    updates: Partial<Pick<ItemType, 'name' | 'code' | 'isSellable' | 'isDefault' | 'isActive'>>,
  ): ItemType {
    const existing = this.itemTypes.get(id);
    if (!existing) throw new Error(`Item type ${id} not found`);

    let nextCode = existing.code;
    if (updates.code !== undefined) {
      nextCode = Math.trunc(Number(updates.code));
      if (
        !Number.isInteger(Number(updates.code)) ||
        !Number.isFinite(nextCode) ||
        nextCode < 0
      ) {
        throw new Error('Item type code must be a non-negative integer from the tax authority');
      }
      const clash = Array.from(this.itemTypes.values()).find(
        (t) => t.id !== id && t.code === nextCode,
      );
      if (clash) throw new Error(`Item type code ${nextCode} is already in use`);
    }

    const nextName =
      updates.name !== undefined ? String(updates.name).trim() : existing.name;
    if (!nextName) throw new Error('Item type name is required');

    if (updates.isDefault === true) {
      for (const type of this.itemTypes.values()) {
        if (type.id !== id && type.isDefault) {
          this.itemTypes.set(type.id, {
            ...type,
            isDefault: false,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    if (updates.isDefault === false && existing.isDefault) {
      throw new Error('Set another item type as default before unsetting this one');
    }

    const updated: ItemType = {
      ...existing,
      name: nextName,
      code: nextCode,
      isSellable:
        updates.isSellable !== undefined ? Boolean(updates.isSellable) : existing.isSellable,
      isDefault: updates.isDefault !== undefined ? Boolean(updates.isDefault) : existing.isDefault,
      isActive: updates.isActive !== undefined ? Boolean(updates.isActive) : existing.isActive,
      updatedAt: new Date().toISOString(),
    };
    this.itemTypes.set(id, updated);

    // Keep denormalized product fields in sync
    const now = new Date().toISOString();
    for (const prod of this.products.values()) {
      if (prod.itemTypeId === id) {
        this.products.set(prod.id, {
          ...prod,
          itemTypeName: updated.name,
          itemTypeCode: updated.code,
          isSellable: updated.isSellable,
          updatedAt: now,
        });
      }
    }

    this.broadcast('item_type_update', { type: 'updated', itemType: updated });
    this.broadcast('inventory_update', {
      type: 'products_reassigned',
      products: Array.from(this.products.values()),
    });
    return updated;
  }

  public setDefaultItemType(id: string): ItemType {
    const target = this.itemTypes.get(id);
    if (!target) throw new Error(`Item type ${id} not found`);

    const now = new Date().toISOString();
    for (const type of this.itemTypes.values()) {
      this.itemTypes.set(type.id, {
        ...type,
        isDefault: type.id === id,
        updatedAt: now,
      });
    }
    const updated = this.itemTypes.get(id)!;
    this.broadcast('item_type_update', { type: 'default_changed', defaultId: id });
    return updated;
  }

  public deleteItemType(id: string): boolean {
    const existing = this.itemTypes.get(id);
    if (!existing) return false;

    const inUse = Array.from(this.products.values()).some((p) => p.itemTypeId === id);
    if (inUse) {
      throw new Error(
        'Cannot delete an item type that is assigned to products. Reassign those products first.',
      );
    }

    if (existing.isDefault) {
      throw new Error('Cannot delete the default item type. Set another type as default first.');
    }

    const deleted = this.itemTypes.delete(id);
    if (deleted) {
      this.broadcast('item_type_update', { type: 'deleted', itemTypeId: id });
    }
    return deleted;
  }

  // ==========================================================================
  // Tax Category Management CRUD (Dynamic, multi-jurisdiction scaling)
  // ==========================================================================
  public getAllTaxCategories(): TaxCategory[] {
    const list = Array.from(this.taxCategories.values());
    // Calculate products assigned to each tax category
    return list.map((tax) => {
      const count = Array.from(this.products.values()).filter(
        (p) => p.taxCategoryId === tax.id,
      ).length;
      return { ...tax, productCount: count };
    });
  }

  public getTaxCategoryById(id: string): TaxCategory | undefined {
    return this.taxCategories.get(id);
  }

  /** Wipe all tax categories (in-memory store has no Postgres tax table). */
  public clearTaxCategories(): number {
    const n = this.taxCategories.size;
    this.taxCategories.clear();
    return n;
  }

  public createTaxCategory(
    data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): TaxCategory {
    const id = `tax_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // If set as default, unset others
    if (data.isDefault) {
      for (const tax of this.taxCategories.values()) {
        tax.isDefault = false;
      }
    }

    const newTax: TaxCategory = {
      ...data,
      id,
      code: (data.code || data.name).toUpperCase().replace(/[^A-Z0-9_]+/g, '_'),
      rate: Number(data.rate) || 0,
      isInclusive: data.isInclusive !== undefined ? data.isInclusive : true,
      isDefault: Boolean(data.isDefault),
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.taxCategories.set(id, newTax);
    this.broadcast('tax_update', { type: 'created', taxCategory: newTax });
    return newTax;
  }

  public updateTaxCategory(id: string, updates: Partial<TaxCategory>): TaxCategory {
    const existing = this.taxCategories.get(id);
    if (!existing) throw new Error(`Tax category ${id} not found`);

    if (updates.isDefault) {
      for (const tax of this.taxCategories.values()) {
        tax.isDefault = false;
      }
    }

    const updated: TaxCategory = {
      ...existing,
      ...updates,
      id,
      rate: updates.rate !== undefined ? Number(updates.rate) : existing.rate,
      updatedAt: new Date().toISOString(),
    };

    this.taxCategories.set(id, updated);

    // Update any products using this tax category if tax rate changed
    if (updates.rate !== undefined || updates.name !== undefined) {
      for (const prod of this.products.values()) {
        if (prod.taxCategoryId === id) {
          if (updates.rate !== undefined) prod.taxRate = Number(updates.rate);
          if (updates.name !== undefined) prod.taxCategoryName = updates.name;
          prod.updatedAt = new Date().toISOString();
        }
      }
    }

    this.broadcast('tax_update', { type: 'updated', taxCategory: updated });
    return updated;
  }

  public deleteTaxCategory(id: string): boolean {
    const existing = this.taxCategories.get(id);
    if (!existing) return false;

    // Check if it's default
    if (existing.isDefault) {
      throw new Error(
        'Cannot delete the default tax category. Set another category as default first.',
      );
    }

    // Reassign products to standard default or remove taxCategoryId
    const defaultTax = Array.from(this.taxCategories.values()).find(
      (t) => t.isDefault && t.id !== id,
    );
    for (const prod of this.products.values()) {
      if (prod.taxCategoryId === id) {
        if (defaultTax) {
          prod.taxCategoryId = defaultTax.id;
          prod.taxCategoryName = defaultTax.name;
          prod.taxRate = defaultTax.rate;
        } else {
          prod.taxCategoryId = undefined;
          prod.taxCategoryName = undefined;
          prod.taxRate = 0;
        }
        prod.updatedAt = new Date().toISOString();
      }
    }

    const deleted = this.taxCategories.delete(id);
    if (deleted) {
      this.broadcast('tax_update', { type: 'deleted', taxCategoryId: id });
    }
    return deleted;
  }

  public setDefaultTaxCategory(id: string): TaxCategory {
    const target = this.taxCategories.get(id);
    if (!target) throw new Error(`Tax category ${id} not found`);

    for (const tax of this.taxCategories.values()) {
      tax.isDefault = tax.id === id;
      tax.updatedAt = new Date().toISOString();
    }

    this.broadcast('tax_update', { type: 'default_changed', defaultId: id });
    return target;
  }

  // ==========================================================================
  // Currency Management CRUD (Multi-Market scaling)
  // ==========================================================================
  public getAllCurrencies(): CurrencyConfig[] {
    return Array.from(this.currencies.values()).sort((a, b) => {
      if (a.isBaseCurrency) return -1;
      if (b.isBaseCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
  }

  public getCurrencyByCode(code: string): CurrencyConfig | undefined {
    return this.currencies.get(code.toUpperCase());
  }

  public createCurrency(data: CurrencyConfig): CurrencyConfig {
    const code = data.code.toUpperCase().trim();
    if (this.currencies.has(code)) {
      throw new Error(`Currency ${code} already exists.`);
    }

    if (data.isBaseCurrency) {
      for (const cur of this.currencies.values()) {
        cur.isBaseCurrency = false;
      }
    }

    const newCurrency: CurrencyConfig = {
      ...data,
      code,
      exchangeRate: Number(data.exchangeRate) || 1.0,
      decimalDigits: data.decimalDigits !== undefined ? Number(data.decimalDigits) : 2,
      symbolPosition: data.symbolPosition || 'prefix',
      isEnabled: data.isEnabled !== undefined ? data.isEnabled : true,
      updatedAt: new Date().toISOString(),
    };

    this.currencies.set(code, newCurrency);
    this.broadcast('currency_update', { type: 'created', currency: newCurrency });
    return newCurrency;
  }

  public updateCurrency(code: string, updates: Partial<CurrencyConfig>): CurrencyConfig {
    const upperCode = code.toUpperCase().trim();
    const existing = this.currencies.get(upperCode);
    if (!existing) throw new Error(`Currency ${upperCode} not found`);

    if (updates.isBaseCurrency) {
      for (const cur of this.currencies.values()) {
        cur.isBaseCurrency = false;
      }
    }

    const updated: CurrencyConfig = {
      ...existing,
      ...updates,
      code: upperCode,
      exchangeRate:
        updates.exchangeRate !== undefined ? Number(updates.exchangeRate) : existing.exchangeRate,
      updatedAt: new Date().toISOString(),
    };

    this.currencies.set(upperCode, updated);
    this.broadcast('currency_update', { type: 'updated', currency: updated });
    return updated;
  }

  public deleteCurrency(code: string): boolean {
    const upperCode = code.toUpperCase().trim();
    const existing = this.currencies.get(upperCode);
    if (!existing) return false;

    if (existing.isBaseCurrency) {
      throw new Error(
        'Cannot delete the primary base currency. Designate another base currency first.',
      );
    }

    const deleted = this.currencies.delete(upperCode);
    if (deleted) {
      this.broadcast('currency_update', { type: 'deleted', currencyCode: upperCode });
    }
    return deleted;
  }

  public setBaseCurrency(code: string): CurrencyConfig {
    const upperCode = code.toUpperCase().trim();
    const target = this.currencies.get(upperCode);
    if (!target) throw new Error(`Currency ${upperCode} not found`);

    for (const cur of this.currencies.values()) {
      cur.isBaseCurrency = cur.code === upperCode;
      cur.updatedAt = new Date().toISOString();
    }

    this.broadcast('currency_update', { type: 'base_changed', baseCurrency: upperCode });
    return target;
  }

  // ==========================================================================
  // Enterprise Inventory Operations (Receive, Write-off, Cycle Count Audit)
  // ==========================================================================

  // Stock In / PO Receiving
  public receiveStock(
    productId: string,
    quantity: number,
    supplier: string,
    poNumber: string,
    unitCost?: number,
    notes?: string,
    actor = 'admin',
  ): Product {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (quantity <= 0) throw new Error('Received quantity must be greater than 0');

    const prevStock = prod.stockQuantity;
    prod.stockQuantity += quantity;
    if (unitCost !== undefined && unitCost > 0) {
      prod.costPrice = unitCost;
    }
    prod.updatedAt = new Date().toISOString();

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: quantity,
      previousStock: prevStock,
      newStock: prod.stockQuantity,
      changeType: 'purchase_order_receipt',
      referenceId: poNumber || `PO-${Date.now()}`,
      actor,
      note: `Received ${quantity} units from supplier "${supplier || 'Standard Supplier'}". ${notes || ''}`.trim(),
      timestamp: new Date().toISOString(),
    });

    this.broadcast('inventory_update', {
      type: 'stock_received',
      productId: prod.id,
      products: Array.from(this.products.values()),
    });

    return prod;
  }

  // Stock Out / Damage, Loss, Shrinkage Write-off
  public writeOffStock(
    productId: string,
    quantity: number,
    reasonCode:
      | 'damage_transit'
      | 'defective_return'
      | 'warehouse_damage'
      | 'shrinkage_loss'
      | 'sample_marketing',
    notes?: string,
    actor = 'admin',
  ): Product {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (quantity <= 0) throw new Error('Write-off quantity must be greater than 0');
    if (quantity > prod.stockQuantity)
      throw new Error(
        `Cannot write off ${quantity} units; only ${prod.stockQuantity} currently on hand.`,
      );

    const prevStock = prod.stockQuantity;
    prod.stockQuantity -= quantity;
    prod.updatedAt = new Date().toISOString();

    const reasonLabelMap = {
      damage_transit: 'Damaged in Courier Transit',
      defective_return: 'Defective Customer Return',
      warehouse_damage: 'Damaged in Warehouse Storage',
      shrinkage_loss: 'Inventory Shrinkage / Missing Item',
      sample_marketing: 'Promotional / Demo Unit',
    };

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: -quantity,
      previousStock: prevStock,
      newStock: prod.stockQuantity,
      changeType: 'damage_writeoff',
      referenceId: `WRITEOFF-${Date.now()}`,
      actor,
      note: `Stock Write-off (${reasonLabelMap[reasonCode] || reasonCode}). ${notes || ''}`.trim(),
      timestamp: new Date().toISOString(),
    });

    this.broadcast('inventory_update', {
      type: 'stock_writeoff',
      productId: prod.id,
      products: Array.from(this.products.values()),
    });

    return prod;
  }

  // Physical Stock Count / Cycle Audit
  public physicalStockAudit(
    productId: string,
    countedQuantity: number,
    notes?: string,
    actor = 'inventory_auditor',
  ): { product: Product; discrepancy: number } {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (countedQuantity < 0) throw new Error('Physical count cannot be negative');

    const previousStock = prod.stockQuantity;
    const discrepancy = countedQuantity - previousStock;
    prod.stockQuantity = countedQuantity;
    prod.updatedAt = new Date().toISOString();

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: discrepancy,
      previousStock,
      newStock: countedQuantity,
      changeType: 'physical_audit',
      referenceId: `AUDIT-${Date.now()}`,
      actor,
      note: `Physical Shelf Count Audit: Counted ${countedQuantity} (Discrepancy: ${discrepancy >= 0 ? '+' : ''}${discrepancy}). ${notes || ''}`.trim(),
      timestamp: new Date().toISOString(),
    });

    this.broadcast('inventory_update', {
      type: 'audit_completed',
      productId: prod.id,
      products: Array.from(this.products.values()),
    });

    return { product: prod, discrepancy };
  }

  // Manual Stock Adjustment
  public manualAdjustStock(
    productId: string,
    newQuantity: number,
    reason = 'Manual Adjustment',
    actor = 'admin',
  ): Product {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (newQuantity < 0) throw new Error('Stock quantity cannot be negative');

    const prevStock = prod.stockQuantity;
    const diff = newQuantity - prevStock;
    prod.stockQuantity = newQuantity;
    prod.updatedAt = new Date().toISOString();

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: diff,
      previousStock: prevStock,
      newStock: newQuantity,
      changeType: 'manual_adjustment',
      referenceId: `ADJ-${Date.now()}`,
      actor,
      note: reason,
      timestamp: new Date().toISOString(),
    });

    this.broadcast('inventory_update', {
      type: 'stock_adjusted',
      productId: prod.id,
      products: Array.from(this.products.values()),
    });

    return prod;
  }

  // Batch Stock Adjust
  public batchStockAdjust(
    adjustments: { productId: string; newQuantity: number; reason: string }[],
    actor = 'admin',
  ): Product[] {
    const updated: Product[] = [];
    for (const adj of adjustments) {
      const prod = this.manualAdjustStock(adj.productId, adj.newQuantity, adj.reason, actor);
      if (prod) updated.push(prod);
    }
    return updated;
  }

  // ==========================================================================
  // Order Fulfillment & Lifecycle Operations
  // ==========================================================================
  public updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    shippingCourier?: string,
    trackingNumber?: string,
    internalNotes?: string,
  ): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    order.status = status;
    if (shippingCourier) order.shippingCourier = shippingCourier;
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (internalNotes !== undefined) order.internalNotes = internalNotes;

    if (status === 'shipped' && !order.shippedAt) {
      order.shippedAt = new Date().toISOString();
    }
    if (status === 'delivered' && !order.deliveredAt) {
      order.deliveredAt = new Date().toISOString();
    }
    if (status === 'completed' && !order.deliveredAt) {
      order.deliveredAt = new Date().toISOString();
    }

    order.updatedAt = new Date().toISOString();
    this.broadcast('order_updated', order);
    return order;
  }

  public cancelOrderAndRestock(orderId: string, reason: string, actor = 'admin'): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (order.status === 'cancelled') {
      throw new Error('Order is already cancelled');
    }

    // Restock items
    for (const item of order.items) {
      const prod = this.products.get(item.productId);
      if (prod) {
        const prevStock = prod.stockQuantity;
        prod.stockQuantity += item.quantity;
        prod.updatedAt = new Date().toISOString();

        this.inventoryLedger.push({
          id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          productId: prod.id,
          productName: prod.name,
          changeAmount: item.quantity,
          previousStock: prevStock,
          newStock: prod.stockQuantity,
          changeType: 'order_cancellation_release',
          referenceId: order.orderNumber,
          actor,
          note: `Restocked ${item.quantity} units due to cancellation of order ${order.orderNumber}. Reason: ${reason || 'Admin Cancelled'}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    order.status = 'cancelled';
    order.internalNotes = `${order.internalNotes ? `${order.internalNotes}\n` : ''}[Cancelled by ${actor}: ${reason}]`;
    order.updatedAt = new Date().toISOString();

    this.broadcast('order_updated', order);
    this.broadcast('inventory_update', {
      type: 'order_cancelled_restock',
      orderId,
      products: Array.from(this.products.values()),
    });

    return order;
  }
}

const globalForDb = globalThis as unknown as { omniDb?: PostgresStore };

export const db = globalForDb.omniDb ?? new PostgresStore();

if (process.env.NODE_ENV !== 'production') {
  // Dev hot reload reuses this object, which was constructed from an older class.
  Object.setPrototypeOf(db, PostgresStore.prototype);
  globalForDb.omniDb = db;
}
