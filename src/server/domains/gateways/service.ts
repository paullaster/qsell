import { db } from '@/server/db/store';
import type { PaymentGatewayConfig, Order, TransactionRecord } from '@/types/index';

export class AdminService {
  static getPaymentGateways(): PaymentGatewayConfig[] {
    return Array.from(db.paymentGateways.values());
  }

  static updatePaymentGateway(
    id: string,
    updates: Partial<PaymentGatewayConfig>
  ): PaymentGatewayConfig {
    const existing = db.paymentGateways.get(id);
    if (!existing) throw new Error(`Payment Gateway ${id} not found`);

    const updated: PaymentGatewayConfig = {
      ...existing,
      ...updates,
      credentials: {
        ...existing.credentials,
        ...(updates.credentials || {}),
      },
    };

    db.paymentGateways.set(id, updated);
    db.broadcast('payment_gateway_updated', updated);
    return updated;
  }

  static getAllOrders(): Order[] {
    return Array.from(db.orders.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  static getAllTransactions(): TransactionRecord[] {
    return Array.from(db.transactions.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}
