import { db } from '../../../db/postgresStore.js';
import { TransactionRecord, Order } from '../../../../src/types/index.js';
import { ReconciliationEngine } from '../../reconciliation/reconciliationEngine.js';

export interface StkPushRequest {
  orderId: string;
  phoneNumber: string; // 2547XXXXXXXX
  amount: number;
  accountReference?: string;
  transactionDesc?: string;
}

export interface StkPushResponse {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
  orderId: string;
  transactionId: string;
}

export class DarajaService {
  private static formatPhoneNumber(phone: string): string {
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
      clean = '254' + clean.slice(1);
    } else if (clean.startsWith('+254')) {
      clean = clean.slice(1);
    } else if (!clean.startsWith('254') && clean.length === 9) {
      clean = '254' + clean;
    }
    return clean;
  }

  public static async initiateStkPush(params: StkPushRequest): Promise<StkPushResponse> {
    const order = db.orders.get(params.orderId);
    if (!order) {
      throw new Error(`Order ${params.orderId} not found`);
    }

    const gateway = db.paymentGateways.get('gw_mpesa_daraja');
    if (!gateway || !gateway.isEnabled) {
      throw new Error('M-Pesa Daraja payment gateway is currently disabled by administrator');
    }

    const formattedPhone = this.formatPhoneNumber(params.phoneNumber);
    if (formattedPhone.length !== 12 || !formattedPhone.startsWith('254')) {
      throw new Error('Invalid Kenyan phone number. Please enter a valid Safaricom number, e.g., 0712345678 or 254712345678');
    }

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const checkoutRequestId = `ws_CO_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const merchantRequestId = `${Math.floor(10000 + Math.random() * 90000)}-${Date.now()}-1`;
    const transactionId = `tx_${Date.now()}_mpesa`;

    // Record Transaction in PostgreSQL Store
    const transaction: TransactionRecord = {
      id: transactionId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      gatewayProvider: 'mpesa_daraja',
      transactionReference: checkoutRequestId,
      amount: params.amount,
      currency: 'KES',
      status: 'pending',
      customerPhone: formattedPhone,
      customerEmail: order.customerEmail,
      requestPayload: {
        BusinessShortCode: gateway.credentials.shortcode || '174379',
        Password: Buffer.from(`${gateway.credentials.shortcode || '174379'}${gateway.credentials.passkey || ''}${timestamp}`).toString('base64'),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: params.amount,
        PartyA: formattedPhone,
        PartyB: gateway.credentials.shortcode || '174379',
        PhoneNumber: formattedPhone,
        CallBackURL: '/api/payments/daraja/callback',
        AccountReference: params.accountReference || order.orderNumber,
        TransactionDesc: params.transactionDesc || `Payment for order ${order.orderNumber}`
      },
      responsePayload: {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing'
      },
      ipnStatus: 'pending',
      reconciliationStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.transactions.set(transactionId, transaction);

    // Update order reference
    order.paymentStatus = 'pending_verification';
    order.transactionReference = checkoutRequestId;
    order.updatedAt = new Date().toISOString();

    db.broadcast('transaction_event', {
      type: 'stk_initiated',
      transactionId,
      checkoutRequestId,
      orderId: order.id,
      amount: params.amount,
      phoneNumber: formattedPhone
    });

    return {
      merchantRequestId,
      checkoutRequestId,
      responseCode: '0',
      responseDescription: 'Success. Request accepted for processing',
      customerMessage: `STK push prompt sent to ${formattedPhone}. Please check your phone and enter M-Pesa PIN.`,
      orderId: order.id,
      transactionId
    };
  }

  // Handle Callback from Safaricom Daraja LNMO Webhook
  public static async processCallback(callbackPayload: any): Promise<{ success: boolean; message: string }> {
    const stkCallback = callbackPayload?.Body?.stkCallback || callbackPayload;
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const resultCode = Number(stkCallback?.ResultCode);
    const resultDesc = stkCallback?.ResultDesc || 'No description';

    // Find matching transaction
    const transaction = Array.from(db.transactions.values()).find(
      tx => tx.transactionReference === checkoutRequestId
    );

    if (!transaction) {
      console.warn(`[Daraja Callback] No transaction found matching CheckoutRequestID: ${checkoutRequestId}`);
      return { success: false, message: 'Transaction not found' };
    }

    const order = db.orders.get(transaction.orderId);

    if (resultCode === 0) {
      // Payment Successful
      let mpesaReceiptNumber = `QHD${Math.floor(100000 + Math.random() * 900000)}`;
      let amountPaid = transaction.amount;
      let phone = transaction.customerPhone;

      const items = stkCallback?.CallbackMetadata?.Item;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.Name === 'MpesaReceiptNumber') mpesaReceiptNumber = String(item.Value);
          if (item.Name === 'Amount') amountPaid = Number(item.Value);
          if (item.Name === 'PhoneNumber') phone = String(item.Value);
        }
      }

      transaction.status = 'successful';
      transaction.externalReference = mpesaReceiptNumber;
      transaction.ipnStatus = 'delivered';
      transaction.responsePayload = { ...transaction.responsePayload, callback: callbackPayload };
      transaction.updatedAt = new Date().toISOString();

      if (order) {
        order.paymentStatus = 'paid';
        order.status = 'completed';
        order.mpesaReceiptNumber = mpesaReceiptNumber;
        order.updatedAt = new Date().toISOString();

        // Transactional stock deduction
        db.atomicFulfillStock(
          order.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
          order.id
        );

        // Run auto near real-time reconciliation immediately
        ReconciliationEngine.reconcileSingleTransaction(transaction, order);
      }

      db.broadcast('transaction_event', {
        type: 'stk_successful',
        transactionId: transaction.id,
        checkoutRequestId,
        receiptNumber: mpesaReceiptNumber,
        orderId: order?.id,
        orderNumber: order?.orderNumber
      });

      return { success: true, message: 'Callback processed and reconciled successfully' };
    } else {
      // Payment Cancelled or Failed (e.g. 1032 = cancelled by user, 1037 = timeout, 1 = insufficient balance)
      transaction.status = 'failed';
      transaction.errorMessage = resultDesc;
      transaction.ipnStatus = 'delivered';
      transaction.updatedAt = new Date().toISOString();

      if (order) {
        order.paymentStatus = 'failed';
        order.status = 'failed';
        order.updatedAt = new Date().toISOString();

        // Release inventory reservation
        db.atomicReleaseReservation(
          order.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
          order.id
        );
      }

      db.broadcast('transaction_event', {
        type: 'stk_failed',
        transactionId: transaction.id,
        checkoutRequestId,
        error: resultDesc,
        orderId: order?.id
      });

      return { success: false, message: `Payment failed: ${resultDesc}` };
    }
  }

  // Simulation Trigger for testing interactive STK push
  public static async simulateUserStkAction(checkoutRequestId: string, action: 'accept' | 'cancel' | 'wrong_pin' | 'timeout'): Promise<any> {
    const transaction = Array.from(db.transactions.values()).find(
      tx => tx.transactionReference === checkoutRequestId
    );

    if (!transaction) {
      throw new Error(`Checkout Request ID ${checkoutRequestId} not found.`);
    }

    if (action === 'accept') {
      const mockReceipt = `QHD${Math.floor(1000000 + Math.random() * 9000000)}`;
      const callbackPayload = {
        Body: {
          stkCallback: {
            MerchantRequestID: '29115-34620561-1',
            CheckoutRequestID: checkoutRequestId,
            ResultCode: 0,
            ResultDesc: 'The service request is processed successfully.',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: transaction.amount },
                { Name: 'MpesaReceiptNumber', Value: mockReceipt },
                { Name: 'Balance', Value: 0 },
                { Name: 'TransactionDate', Value: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) },
                { Name: 'PhoneNumber', Value: transaction.customerPhone || '254712345678' }
              ]
            }
          }
        }
      };
      await this.processCallback(callbackPayload);
      return { status: 'successful', receipt: mockReceipt };
    } else {
      const errorMap = {
        cancel: { code: 1032, desc: 'Request cancelled by user on mobile phone.' },
        wrong_pin: { code: 2001, desc: 'The initiator information is invalid. Wrong M-Pesa PIN.' },
        timeout: { code: 1037, desc: 'DS timeout user cannot be reached or did not respond in 30 seconds.' }
      };
      const err = errorMap[action] || errorMap.cancel;
      const callbackPayload = {
        Body: {
          stkCallback: {
            MerchantRequestID: '29115-34620561-1',
            CheckoutRequestID: checkoutRequestId,
            ResultCode: err.code,
            ResultDesc: err.desc
          }
        }
      };
      await this.processCallback(callbackPayload);
      return { status: 'failed', error: err.desc };
    }
  }
}
