import { db } from '../../db/postgresStore.js';
import { UserSession, Order, OrderItem, PaymentProvider, CustomerAccount } from '../../../src/types/index.js';

export class SessionManager {
  public static createSession(
    role: 'admin' | 'manager' | 'customer', 
    email: string = 'paullasterokoth98@gmail.com', 
    name: string = 'Paul Laster Okoth',
    phone: string = '0712345678'
  ): UserSession {
    let userId = role === 'admin' ? 'usr_admin_001' : '';

    if (role === 'customer') {
      let existingCustomer = db.getCustomerByEmailOrPhone(email) || db.getCustomerByEmailOrPhone(phone);
      if (!existingCustomer) {
        existingCustomer = db.createCustomer({
          name,
          email,
          phone,
          role: 'customer',
          status: 'verified',
          addresses: [
            {
              id: `addr_${Date.now()}`,
              label: 'Primary Delivery Address',
              recipientName: name,
              recipientPhone: phone,
              street: 'Riverside Drive, Delta Corner Suite 4A',
              city: 'Nairobi',
              countyOrState: 'Nairobi County',
              country: 'Kenya',
              isDefault: true
            }
          ],
          paymentPreferences: {
            preferredMethod: 'mpesa_daraja',
            defaultMpesaPhone: phone
          }
        });
      }
      userId = existingCustomer.id;
    } else {
      userId = 'usr_admin_001';
    }

    const token = `bff_sec_${Buffer.from(`${userId}:${role}:${Date.now()}`).toString('base64')}`;
    
    const session: UserSession = {
      userId,
      email,
      name,
      role,
      token,
      createdAt: new Date().toISOString()
    };

    db.userSessions.set(token, session);
    return session;
  }

  public static getSession(token?: string): UserSession | null {
    if (!token) return null;
    return db.userSessions.get(token) || null;
  }

  public static createOrder(params: {
    userId: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
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
  }): { success: boolean; order?: Order; error?: string } {
    // 1. Calculate pricing and build order items
    const orderItems: OrderItem[] = [];
    let subtotal = 0;

    for (const item of params.items) {
      const prod = db.products.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product ID ${item.productId} does not exist.` };
      }
      const itemTotal = prod.price * item.quantity;
      subtotal += itemTotal;
      orderItems.push({
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        quantity: item.quantity,
        unitPrice: prod.price,
        totalPrice: itemTotal,
        imageUrl: prod.imageUrl
      });
    }

    const tax = Math.round(subtotal * 0.16); // 16% VAT standard
    const shippingFee = subtotal > 100000 ? 0 : 500; // Free shipping above KES 100,000
    const totalAmount = subtotal + tax + shippingFee;
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const orderNumber = `ORD-2026-${Math.floor(1000 + Math.random() * 9000)}`;

    // 2. Transactional Atomic Stock Reservation
    const reservation = db.atomicReserveStock(params.items, orderId, params.customerEmail);
    if (!reservation.success) {
      return { success: false, error: reservation.error };
    }

    // 3. Resolve Customer Account linking
    let resolvedUserId = params.userId;
    let customer = db.getCustomerById(params.userId) || db.getCustomerByEmailOrPhone(params.customerEmail);
    if (!customer) {
      // Auto-create customer record
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
            isDefault: true
          }
        ],
        paymentPreferences: {
          preferredMethod: params.paymentMethod,
          defaultMpesaPhone: params.customerPhone
        }
      });
      resolvedUserId = customer.id;
    } else {
      resolvedUserId = customer.id;
      // Increment stats
      customer.totalOrders = (customer.totalOrders || 0) + 1;
      customer.lastOrderDate = new Date().toISOString();
      customer.updatedAt = new Date().toISOString();
      db.broadcast('customer_updated', customer);
    }

    // 4. Create and Save Order
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.orders.set(orderId, order);

    db.broadcast('order_event', {
      type: 'order_created',
      order
    });

    return { success: true, order };
  }
}
