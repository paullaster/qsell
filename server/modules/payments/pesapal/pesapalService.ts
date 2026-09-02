import { db } from '../../../db/postgresStore.js';
import { TransactionRecord, Order } from '../../../../src/types/index.js';
import { ReconciliationEngine } from '../../reconciliation/reconciliationEngine.js';

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
  public static async submitOrder(params: PesapalOrderRequest): Promise<PesapalOrderResponse> {
    const order = db.orders.get(params.orderId);
    if (!order) {
      throw new Error(`Order ${params.orderId} not found`);
    }

    const gateway = db.paymentGateways.get('gw_pesapal_v3');
    if (!gateway || !gateway.isEnabled) {
      throw new Error('Pesapal payment gateway is disabled by administrator');
    }

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
      amount: params.amount,
      currency: params.currency,
      status: 'pending',
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      requestPayload: {
        id: merchantReference,
        currency: params.currency,
        amount: params.amount,
        description: params.description || `OmniCommerce Order ${order.orderNumber}`,
        callback_url: params.callbackUrl || '/api/payments/pesapal/ipn',
        notification_id: gateway.credentials.ipnId || 'ipn_88fa7b49-default',
        billing_address: order.shippingAddress
      },
      responsePayload: {
        order_tracking_id: orderTrackingId,
        merchant_reference: merchantReference,
        redirect_url: redirectUrl,
        status: '200'
      },
      ipnStatus: 'pending',
      reconciliationStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.transactions.set(transactionId, transaction);

    order.paymentStatus = 'pending_verification';
    order.pesapalTrackingId = orderTrackingId;
    order.transactionReference = merchantReference;
    order.updatedAt = new Date().toISOString();

    db.broadcast('transaction_event', {
      type: 'pesapal_initiated',
      transactionId,
      orderTrackingId,
      orderId: order.id,
      amount: params.amount
    });

    return {
      orderTrackingId,
      merchantReference,
      redirectUrl,
      status: '200',
      transactionId
    };
  }

  public static async processIpn(orderTrackingId: string, merchantReference: string, status: string = 'COMPLETED'): Promise<any> {
    const transaction = Array.from(db.transactions.values()).find(
      tx => tx.externalReference === orderTrackingId || tx.transactionReference === merchantReference
    );

    if (!transaction) {
      console.warn(`[Pesapal IPN] Transaction not found for tracking ID: ${orderTrackingId}`);
      return { success: false, message: 'Transaction not found' };
    }

    const order = db.orders.get(transaction.orderId);

    if (status.toUpperCase() === 'COMPLETED' || status.toUpperCase() === 'SUCCESS') {
      transaction.status = 'successful';
      transaction.ipnStatus = 'delivered';
      transaction.updatedAt = new Date().toISOString();

      if (order) {
        order.paymentStatus = 'paid';
        order.status = 'completed';
        order.pesapalTrackingId = orderTrackingId;
        order.updatedAt = new Date().toISOString();

        // Stock fulfillment
        db.atomicFulfillStock(
          order.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
          order.id
        );

        // Immediate Auto-Reconciliation
        ReconciliationEngine.reconcileSingleTransaction(transaction, order);
      }

      db.broadcast('transaction_event', {
        type: 'pesapal_completed',
        transactionId: transaction.id,
        orderTrackingId,
        orderId: order?.id,
        orderNumber: order?.orderNumber
      });

      return { success: true, message: 'Pesapal IPN verified and reconciled' };
    } else {
      transaction.status = 'failed';
      transaction.ipnStatus = 'delivered';
      transaction.errorMessage = `Pesapal returned status: ${status}`;
      transaction.updatedAt = new Date().toISOString();

      if (order) {
        order.paymentStatus = 'failed';
        order.status = 'failed';
        order.updatedAt = new Date().toISOString();

        db.atomicReleaseReservation(
          order.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
          order.id
        );
      }

      return { success: false, message: `Pesapal payment failed with status ${status}` };
    }
  }

  // Simulate payment completion from Pesapal payment portal
  public static async simulatePesapalPayment(orderTrackingId: string, success: boolean, paymentChannel: 'VISA' | 'MASTERCARD' | 'AIRTEL_MONEY' | 'EQUITY_BANK' = 'VISA'): Promise<any> {
    const status = success ? 'COMPLETED' : 'FAILED';
    return await this.processIpn(orderTrackingId, '', status);
  }
}
