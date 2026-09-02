import { db } from '../../db/postgresStore.js';
import { PaymentGatewayConfig, Order, TransactionRecord } from '../../../src/types/index.js';

export class AdminService {
  public static getPaymentGateways(): PaymentGatewayConfig[] {
    return Array.from(db.paymentGateways.values());
  }

  public static updatePaymentGateway(id: string, updates: Partial<PaymentGatewayConfig>): PaymentGatewayConfig {
    const existing = db.paymentGateways.get(id);
    if (!existing) {
      throw new Error(`Payment Gateway ${id} not found`);
    }

    const updated: PaymentGatewayConfig = {
      ...existing,
      ...updates,
      credentials: {
        ...existing.credentials,
        ...(updates.credentials || {})
      }
    };

    db.paymentGateways.set(id, updated);
    db.broadcast('payment_gateway_updated', updated);

    return updated;
  }

  public static getAllOrders(): Order[] {
    return Array.from(db.orders.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public static getAllTransactions(): TransactionRecord[] {
    return Array.from(db.transactions.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}
