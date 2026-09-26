import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import type { PaymentGatewayConfig, Order, TransactionRecord } from '@/types/index';
import { toGatewayConfig, toTransaction } from '@/server/domains/catalog/mappers';
import { encryptCredentials } from '@/server/domains/payments/crypto';

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Gateway toggles and the operational transaction log, both DB-backed. */
export class AdminService {
  static async getPaymentGateways(): Promise<PaymentGatewayConfig[]> {
    const rows = await getContainer().paymentRecords.listGatewayConfigs();
    return rows.map(toGatewayConfig);
  }

  static async getPaymentGateway(id: string): Promise<PaymentGatewayConfig | null> {
    const row = await getContainer().paymentRecords.getGatewayConfig(id);
    return row ? toGatewayConfig(row) : null;
  }

  static async updatePaymentGateway(
    id: string,
    updates: Partial<PaymentGatewayConfig>,
  ): Promise<PaymentGatewayConfig> {
    const repo = getContainer().paymentRecords;
    const existing = await repo.getGatewayConfig(id);
    if (!existing) throw new Error(`Payment Gateway ${id} not found`);

    const row = await repo.upsertGatewayConfig({
      id,
      provider: updates.provider ?? existing.provider,
      name: updates.name ?? existing.name,
      isEnabled: updates.isEnabled ?? existing.isEnabled,
      environment: updates.environment ?? existing.environment,
      // Merge into the plaintext copy, then reseal: the column only ever
      // holds ciphertext.
      credentialsEncrypted: updates.credentials
        ? encryptCredentials({ ...(toGatewayConfig(existing).credentials ?? {}), ...updates.credentials })
        : existing.credentialsEncrypted,
      supportedCurrencies: updates.supportedCurrencies ?? existing.supportedCurrencies,
      icon: updates.icon ?? existing.icon,
      description: updates.description ?? existing.description,
    });

    const updated = toGatewayConfig(row);
    void broadcastRealtime('payment_gateway_updated', updated);
    return updated;
  }

  static async getAllOrders(): Promise<Order[]> {
    return getContainer().orders.listAll();
  }

  static async getAllTransactions(): Promise<TransactionRecord[]> {
    const rows = await getContainer().paymentRecords.listTransactions();
    return rows.map(toTransaction);
  }

  /** Persist a gateway transaction record. */
  static async saveTransaction(
    transaction: TransactionRecord,
  ): Promise<TransactionRecord> {
    const row = await getContainer().paymentRecords.upsertTransaction({
      id: transaction.id || newId('txn'),
      orderId: transaction.orderId,
      orderNumber: transaction.orderNumber,
      gatewayProvider: transaction.gatewayProvider,
      transactionReference: transaction.transactionReference,
      externalReference: transaction.externalReference ?? null,
      amount: String(transaction.amount),
      currency: transaction.currency,
      status: transaction.status,
      customerPhone: transaction.customerPhone ?? null,
      customerEmail: transaction.customerEmail ?? null,
      requestPayload: transaction.requestPayload as Record<string, unknown>,
      responsePayload: transaction.responsePayload as Record<string, unknown>,
      ipnStatus: transaction.ipnStatus,
      reconciliationStatus: transaction.reconciliationStatus,
      errorMessage: transaction.errorMessage ?? null,
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
    });
    return toTransaction(row);
  }

  static async findTransaction(match: {
    id?: string;
    transactionReference?: string;
  }): Promise<TransactionRecord | null> {
    const row = await getContainer().paymentRecords.findTransaction(match);
    return row ? toTransaction(row) : null;
  }

  static async updateTransactionStatus(
    id: string,
    patch: Partial<TransactionRecord>,
  ): Promise<TransactionRecord | null> {
    const row = await getContainer().paymentRecords.updateTransaction(id, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.ipnStatus !== undefined ? { ipnStatus: patch.ipnStatus } : {}),
      ...(patch.reconciliationStatus !== undefined
        ? { reconciliationStatus: patch.reconciliationStatus }
        : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.responsePayload !== undefined
        ? { responsePayload: patch.responsePayload as Record<string, unknown> }
        : {}),
    });
    return row ? toTransaction(row) : null;
  }
}
