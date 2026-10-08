import type { TransactionRecord } from '@/types/index';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import { toTransaction, toGatewayConfig } from '@/server/domains/catalog/mappers';
import { ReconciliationEngine } from '@/server/domains/reconciliation/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import { amountDue } from '@/server/domains/orders/amount-due';

export interface PesapalOrderRequest {
  orderId: string;
  amount: number;
  currency: 'KES' | 'USD';
  description?: string;
  callbackUrl?: string;
}

export interface PesapalOrderResponse {
  orderTrackingId: string;
  merchantReference: string;
  redirectUrl: string;
  status: string;
  transactionId: string;
}

export class PesapalService {
  static async submitOrder(params: PesapalOrderRequest): Promise<PesapalOrderResponse> {
    const container = getContainer();
    const order = await container.orders.getById(params.orderId);
    if (!order) throw new Error(`Order ${params.orderId} not found`);

    const gatewayRow = await container.paymentRecords.getGatewayConfig('gw_pesapal_v3');
    const gateway = gatewayRow ? toGatewayConfig(gatewayRow) : undefined;
    if (!gateway?.isEnabled) {
      throw new Error('Pesapal payment gateway is disabled by administrator');
    }

    const amount = params.amount || amountDue(order);
    const orderTrackingId = `pesa_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const merchantReference = `REF_${order.orderNumber}_${Date.now()}`;
    const transactionId = `tx_${Date.now()}_pesapal`;
    const redirectUrl = `https://cybqa.pesapal.com/pesapalv3/api/Payment/Redirect?orderTrackingId=${orderTrackingId}`;

    const transaction: TransactionRecord = {
      id: transactionId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      gatewayProvider: 'pesapal_v3',
      transactionReference: merchantReference,
      externalReference: orderTrackingId,
      amount,
      currency: params.currency,
      status: 'pending',
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      requestPayload: {
        id: merchantReference,
        currency: params.currency,
        amount,
        description: params.description || `OmniCommerce Order ${order.orderNumber}`,
        callback_url: params.callbackUrl || '/api/payments/pesapal/ipn',
        notification_id: gateway.credentials.ipnId || 'ipn_88fa7b49-default',
        billing_address: order.shippingAddress,
      },
      responsePayload: {
        order_tracking_id: orderTrackingId,
        merchant_reference: merchantReference,
        redirect_url: redirectUrl,
        status: '200',
      },
      ipnStatus: 'pending',
      reconciliationStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await container.paymentRecords.upsertTransaction({
      id: transaction.id,
      orderId: transaction.orderId,
      orderNumber: transaction.orderNumber,
      gatewayProvider: transaction.gatewayProvider,
      amount: String(transaction.amount),
      currency: transaction.currency ?? 'KES',
      externalReference: transaction.externalReference ?? orderTrackingId,
      transactionReference: transaction.transactionReference,
      status: transaction.status,
      customerPhone: transaction.customerPhone ?? null,
      customerEmail: transaction.customerEmail ?? null,
      requestPayload: transaction.requestPayload ?? {},
      responsePayload: transaction.responsePayload ?? {},
      ipnStatus: transaction.ipnStatus,
      reconciliationStatus: transaction.reconciliationStatus,
      errorMessage: transaction.errorMessage ?? null,
    });
    await container.orders.update(order.id, {
      paymentStatus: 'pending_verification',
      pesapalTrackingId: orderTrackingId,
      transactionReference: merchantReference,
    });

    void broadcastRealtime('transaction_event', {
      type: 'pesapal_initiated',
      transactionId,
      orderTrackingId,
      orderId: order.id,
      amount,
    });

    return {
      orderTrackingId,
      merchantReference,
      redirectUrl,
      status: '200',
      transactionId,
    };
  }

  static async processIpn(
    orderTrackingId: string,
    merchantReference: string,
    status = 'COMPLETED',
  ) {
    const container = getContainer();
    const transactionRow =
      (await container.paymentRecords.findTransaction({ externalReference: orderTrackingId })) ??
      (await container.paymentRecords.findTransaction({ transactionReference: merchantReference }));

    if (!transactionRow) {
      return { success: false, message: 'Transaction not found' };
    }
    const transaction = toTransaction(transactionRow);

    const order = await container.orders.getById(transaction.orderId);

    if (status.toUpperCase() === 'COMPLETED' || status.toUpperCase() === 'SUCCESS') {
      await container.paymentRecords.updateTransaction(transaction.id, {
        status: 'successful',
        ipnStatus: 'delivered',
      });

      if (order) {
        await container.orders.update(order.id, {
          paymentStatus: 'paid',
          status: 'completed',
          pesapalTrackingId: orderTrackingId,
        });
        await InventoryReservationService.fulfilOrder(order.id);
        const settledOrder = (await container.orders.getById(order.id)) ?? order;
        await ReconciliationEngine.reconcileSingleTransaction(transaction, settledOrder);
      }

      void broadcastRealtime('transaction_event', {
        type: 'pesapal_completed',
        transactionId: transaction.id,
        orderTrackingId,
        orderId: order?.id,
        orderNumber: order?.orderNumber,
      });

      return { success: true, message: 'Pesapal IPN verified and reconciled' };
    }

    await container.paymentRecords.updateTransaction(transaction.id, {
      status: 'failed',
      ipnStatus: 'delivered',
      errorMessage: `Pesapal returned status: ${status}`,
    });

    if (order) {
      await container.orders.update(order.id, { paymentStatus: 'failed', status: 'failed' });
      await InventoryReservationService.releaseOrder(order.id, 'pesapal_ipn_failed', 'pesapal_ipn');
    }

    return { success: false, message: `Pesapal payment failed with status ${status}` };
  }

  static async simulatePesapalPayment(
    orderTrackingId: string,
    success: boolean,
    _paymentChannel: 'VISA' | 'MASTERCARD' | 'AIRTEL_MONEY' | 'EQUITY_BANK' = 'VISA',
  ) {
    const status = success ? 'COMPLETED' : 'FAILED';
    return await this.processIpn(orderTrackingId, '', status);
  }
}
