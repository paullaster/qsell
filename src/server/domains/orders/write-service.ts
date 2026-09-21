import { db } from '@/server/db/store';
import type { Order, OrderItem, PaymentProvider } from '@/types/index';
import { computeCheckoutTotals } from '@/lib/checkoutPricing';
import { getContainer } from '@/server/di/container';

export class OrderWriteService {
  static async createOrder(params: {
    userId?: string | null;
    branchId?: string | null;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    buyerKraPin?: string | null;
    shippingAddress: {
      street: string;
      city: string;
      countyOrState: string;
      postalCode?: string;
      country: string;
    };
    items: { productId: string; quantity: number }[];
    currency: 'KES' | 'USD';
    paymentMethod: PaymentProvider;
    /** Flat fields (globalDimension1Code) or { global, shortcut } projection */
    dimensionFields?: Record<string, string | null | undefined> | {
      global: Record<string, string>;
      shortcut: Record<string, string>;
    };
  }): Promise<{ success: boolean; order?: Order; error?: string }> {
    const orderItems: OrderItem[] = [];
    const pricedLines: {
      productId: string;
      quantity: number;
      unitPrice: number;
      taxRate: number;
      isTaxInclusive: boolean;
    }[] = [];

    for (const item of params.items) {
      const prod = db.products.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product ID ${item.productId} does not exist.` };
      }
      if (prod.isSellable === false) {
        return { success: false, error: `${prod.name} is not sellable and cannot be ordered.` };
      }
      if (prod.price == null || !Number.isFinite(prod.price) || prod.price <= 0) {
        return { success: false, error: `${prod.name} has no valid selling price.` };
      }
      const itemTotal = prod.price * item.quantity;
      orderItems.push({
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        quantity: item.quantity,
        unitPrice: prod.price,
        totalPrice: itemTotal,
        imageUrl: prod.imageUrl,
      });
      pricedLines.push({
        productId: prod.id,
        quantity: item.quantity,
        unitPrice: prod.price,
        taxRate: prod.taxRate ?? 0,
        isTaxInclusive: prod.isTaxInclusive !== false,
      });
    }

    const { subtotal, tax, shippingFee, totalAmount } = computeCheckoutTotals(pricedLines);
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const orderNumber = `ORD-2026-${Math.floor(1000 + Math.random() * 9000)}`;

    const reservation = db.atomicReserveStock(params.items, orderId, params.customerEmail);
    if (!reservation.success) {
      return { success: false, error: reservation.error };
    }

    let resolvedUserId = params.userId || '';
    let customer =
      (params.userId ? db.getCustomerById(params.userId) : null) ||
      db.getCustomerByEmailOrPhone(params.customerEmail);

    if (!customer) {
      customer = db.createCustomer({
        name: params.customerName,
        email: params.customerEmail,
        phone: params.customerPhone,
        addresses: [
          {
            id: `addr_${Date.now()}`,
            label: 'Home / Delivery',
            recipientName: params.customerName,
            recipientPhone: params.customerPhone,
            ...params.shippingAddress,
            isDefault: true,
          },
        ],
        paymentPreferences: {
          preferredMethod: params.paymentMethod,
          defaultMpesaPhone: params.customerPhone,
        },
      });
      resolvedUserId = params.userId || customer.id;
    } else {
      resolvedUserId = params.userId || customer.id;
      customer.totalOrders = (customer.totalOrders || 0) + 1;
      customer.lastOrderDate = new Date().toISOString();
      customer.updatedAt = new Date().toISOString();
      db.broadcast('customer_updated', customer);
    }

    const order: Order = {
      id: orderId,
      orderNumber,
      userId: resolvedUserId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      shippingAddress: params.shippingAddress,
      items: orderItems,
      subtotal,
      tax,
      shippingFee,
      totalAmount,
      currency: params.currency,
      status: 'pending',
      paymentStatus: 'unpaid',
      paymentMethod: params.paymentMethod,
      dimensionSetId: null,
      dimensionCodes: { global: {}, shortcut: {} },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      const { companySettings, dimensionSets, customers } = getContainer();
      const company = await companySettings.ensureSeeded();
      const onAccount = params.paymentMethod === 'on_account';
      const tradeCustomer = await customers.prepareSale({
        companyId: company.id,
        name: params.customerName,
        email: params.customerEmail,
        phone: params.customerPhone,
        address: params.shippingAddress,
        buyerKraPin: params.buyerKraPin,
        amount: totalAmount,
        onAccount,
      });
      const callerDimensions = params.dimensionFields;
      const hasCallerDimensions = (() => {
        if (!callerDimensions) return false;
        if ('global' in callerDimensions && 'shortcut' in callerDimensions) {
          const projection = callerDimensions as {
            global: Record<string, string>;
            shortcut: Record<string, string>;
          };
          return Object.keys(projection.global).length + Object.keys(projection.shortcut).length > 0;
        }
        return Object.values(callerDimensions).some((value) => Boolean(value));
      })();
      const assignment = await dimensionSets.resolveAssignment(
        company.id,
        hasCallerDimensions ? callerDimensions! : tradeCustomer.dimensionCodes,
      );
      order.dimensionSetId = assignment.dimensionSetId;
      order.dimensionCodes = assignment.dimensionCodes;
      order.tradeCustomerId = tradeCustomer.id;
      order.customerAccountType = tradeCustomer.accountType as 'cash' | 'credit';
      order.transmitInvoicesToKra = tradeCustomer.transmitInvoicesToKra;
      order.kraTransmissionStatus = tradeCustomer.transmitInvoicesToKra ? 'pending' : 'skipped';

      const { orders: orderRepo } = getContainer();
      await orderRepo.create(order, params.branchId);
      await customers.postInvoice({
        customer: tradeCustomer,
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: totalAmount,
        currency: order.currency,
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Customer or dimension assignment failed',
      };
    }

    // Keep a memory mirror for realtime admin widgets that still read the Map.
    db.orders.set(orderId, order);
    db.broadcast('order_event', { type: 'order_created', order });

    return { success: true, order };
  }
}
