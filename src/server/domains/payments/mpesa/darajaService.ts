import type { TransactionRecord } from '@/types/index';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import { toTransaction, toGatewayConfig } from '@/server/domains/catalog/mappers';
import { ReconciliationEngine } from '@/server/domains/reconciliation/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import { extractPaymentReference } from '@/server/domains/payments/payment-reference';

export interface StkPushRequest {
  orderId: string;
  phoneNumber: string;
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
      clean = `254${clean.slice(1)}`;
    } else if (clean.startsWith('+254')) {
      clean = clean.slice(1);
    } else if (!clean.startsWith('254') && clean.length === 9) {
      clean = `254${clean}`;
    }
    return clean;
  }

  static async initiateStkPush(params: StkPushRequest): Promise<StkPushResponse> {
    const container = getContainer();
    const order = await container.orders.getById(params.orderId);
    if (!order) throw new Error(`Order ${params.orderId} not found`);

    const gatewayRow = await container.paymentRecords.getGatewayConfig('gw_mpesa_daraja');
    const gateway = gatewayRow ? toGatewayConfig(gatewayRow) : undefined;
    if (!gateway?.isEnabled) {
      throw new Error('M-Pesa Daraja payment gateway is currently disabled by administrator');
    }

    const formattedPhone = this.formatPhoneNumber(params.phoneNumber);
    if (formattedPhone.length !== 12 || !formattedPhone.startsWith('254')) {
      throw new Error(
        'Invalid Kenyan phone number. Please enter a valid Safaricom number, e.g., 0712345678 or 254712345678',
      );
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14);
    const checkoutRequestId = `ws_CO_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const merchantRequestId = `${Math.floor(10000 + Math.random() * 90000)}-${Date.now()}-1`;
    const transactionId = `tx_${Date.now()}_mpesa`;
    const amount = params.amount || order.totalAmount;

    const transaction: TransactionRecord = {
      id: transactionId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      gatewayProvider: 'mpesa_daraja',
      transactionReference: checkoutRequestId,
      amount,
      currency: 'KES',
      status: 'pending',
      customerPhone: formattedPhone,
      customerEmail: order.customerEmail,
      requestPayload: {
        BusinessShortCode: gateway.credentials.shortcode || '174379',
        Password: Buffer.from(
          `${gateway.credentials.shortcode || '174379'}${gateway.credentials.passkey || ''}${timestamp}`,
        ).toString('base64'),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: gateway.credentials.shortcode || '174379',
        PhoneNumber: formattedPhone,
        CallBackURL: '/api/payments/daraja/callback',
        AccountReference: params.accountReference || order.orderNumber,
        TransactionDesc: params.transactionDesc || `Payment for order ${order.orderNumber}`,
      },
      responsePayload: {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing',
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
      externalReference: transaction.externalReference ?? null,
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
    await container.orders.update(order.id, { paymentStatus: 'pending_verification' });

    void broadcastRealtime('transaction_event', {
      type: 'stk_initiated',
      transactionId,
      checkoutRequestId,
      orderId: order.id,
      amount,
      phoneNumber: formattedPhone,
    });

    return {
      merchantRequestId,
      checkoutRequestId,
      responseCode: '0',
      responseDescription: 'Success. Request accepted for processing',
      customerMessage: `STK push prompt sent to ${formattedPhone}. Please check your phone and enter M-Pesa PIN.`,
      orderId: order.id,
      transactionId,
    };
  }

  static async processCallback(
    callbackPayload: unknown,
  ): Promise<{ success: boolean; message: string }> {
    const payload = callbackPayload as {
      Body?: { stkCallback?: Record<string, unknown> };
    } & Record<string, unknown>;
    const stkCallback = (payload?.Body?.stkCallback || payload) as {
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: { Name: string; Value: unknown }[] };
    };
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const resultCode = Number(stkCallback?.ResultCode);
    const resultDesc = stkCallback?.ResultDesc || 'No description';

    const container = getContainer();
    const transactionRow = await container.paymentRecords.findTransaction({
      transactionReference: checkoutRequestId,
    });
    if (!transactionRow) {
      return { success: false, message: 'Transaction not found' };
    }
    const transaction = toTransaction(transactionRow);

    const order = await container.orders.getById(transaction.orderId);

    if (resultCode === 0) {
      const mpesaReceiptNumber = extractPaymentReference('mpesa_daraja', callbackPayload);
      if (!mpesaReceiptNumber) {
        return {
          success: false,
          message: 'Successful payment callback had no transaction reference.',
        };
      }

      await container.paymentRecords.updateTransaction(transaction.id, {
        status: 'successful',
        externalReference: mpesaReceiptNumber,
        ipnStatus: 'delivered',
        responsePayload: { ...(transaction.responsePayload ?? {}), callback: callbackPayload },
      });

      if (order) {
        await container.orders.update(order.id, {
          paymentStatus: 'paid',
          status: 'completed',
          mpesaReceiptNumber,
          transactionReference: mpesaReceiptNumber,
        });
        await InventoryReservationService.fulfilOrder(order.id);
        const settledOrder = (await container.orders.getById(order.id)) ?? order;
        await ReconciliationEngine.reconcileSingleTransaction(transaction, settledOrder);
      }

      void broadcastRealtime('transaction_event', {
        type: 'stk_successful',
        transactionId: transaction.id,
        checkoutRequestId,
        receiptNumber: mpesaReceiptNumber,
        orderId: order?.id,
        orderNumber: order?.orderNumber,
      });

      return { success: true, message: 'Callback processed and reconciled successfully' };
    }

    await container.paymentRecords.updateTransaction(transaction.id, {
      status: 'failed',
      errorMessage: resultDesc,
      ipnStatus: 'delivered',
    });

    if (order) {
      await container.orders.update(order.id, { paymentStatus: 'failed', status: 'failed' });
      await InventoryReservationService.releaseOrder(order.id, 'mpesa_stk_failed', 'mpesa_ipn');
    }

    void broadcastRealtime('transaction_event', {
      type: 'stk_failed',
      transactionId: transaction.id,
      checkoutRequestId,
      error: resultDesc,
      orderId: order?.id,
    });

    return { success: false, message: `Payment failed: ${resultDesc}` };
  }

  static async simulateUserStkAction(
    checkoutRequestId: string,
    action: 'accept' | 'cancel' | 'wrong_pin' | 'timeout',
  ) {
    const row = await getContainer().paymentRecords.findTransaction({
      transactionReference: checkoutRequestId,
    });
    if (!row) throw new Error(`Checkout Request ID ${checkoutRequestId} not found.`);
    const transaction = toTransaction(row);

    if (action === 'accept') {
      const mockReceipt = `QHD${Math.floor(1000000 + Math.random() * 9000000)}`;
      await this.processCallback({
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
                {
                  Name: 'TransactionDate',
                  Value: new Date()
                    .toISOString()
                    .replace(/[^0-9]/g, '')
                    .slice(0, 14),
                },
                { Name: 'PhoneNumber', Value: transaction.customerPhone || '254712345678' },
              ],
            },
          },
        },
      });
      return { status: 'successful', receipt: mockReceipt };
    }

    const errorMap = {
      cancel: { code: 1032, desc: 'Request cancelled by user on mobile phone.' },
      wrong_pin: { code: 2001, desc: 'The initiator information is invalid. Wrong M-Pesa PIN.' },
      timeout: {
        code: 1037,
        desc: 'DS timeout user cannot be reached or did not respond in 30 seconds.',
      },
    };
    const err = errorMap[action] || errorMap.cancel;
    await this.processCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: checkoutRequestId,
          ResultCode: err.code,
          ResultDesc: err.desc,
        },
      },
    });
    return { status: 'failed', error: err.desc };
  }
}
