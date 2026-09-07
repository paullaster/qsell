import type { PaymentPort } from './port';
import type { PaymentProviderCode } from './types';
import { MpesaDarajaAdapter } from './adapters/mpesa-daraja.adapter';
import { PesapalV3Adapter } from './adapters/pesapal-v3.adapter';
import { JengaHqAdapter } from './adapters/jenga-hq.adapter';
import { KcbBuniAdapter } from './adapters/kcb-buni.adapter';

/**
 * Composition root for payment adapters. Register new providers here only.
 */
export class PaymentRegistry {
  private readonly adapters = new Map<PaymentProviderCode, PaymentPort>();

  constructor(adapters?: PaymentPort[]) {
    const list = adapters ?? [
      new MpesaDarajaAdapter(),
      new PesapalV3Adapter(),
      new JengaHqAdapter(),
      new KcbBuniAdapter(),
    ];
    for (const adapter of list) {
      this.adapters.set(adapter.code, adapter);
    }
  }

  resolve(code: PaymentProviderCode): PaymentPort {
    const adapter = this.adapters.get(code);
    if (!adapter) {
      throw new Error(`No payment adapter registered for provider "${code}"`);
    }
    return adapter;
  }

  listCodes(): PaymentProviderCode[] {
    return Array.from(this.adapters.keys());
  }
}
