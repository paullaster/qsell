import { AuthService } from '@/server/domains/auth/service';
import type { Order, PaymentProvider } from '@/types/index';

export class OrdersService {
  static async createCheckout(params: {
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
    paymentMethod: PaymentProvider;
    currency?: 'KES' | 'USD';
    userId?: string;
  }): Promise<Order> {
    const session = await AuthService.getSessionFromCookies();
    const result = AuthService.createOrder({
      userId: params.userId || session?.userId || 'guest',
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      shippingAddress: params.shippingAddress,
      items: params.items,
      currency: params.currency || 'KES',
      paymentMethod: params.paymentMethod,
    });

    if (!result.success || !result.order) {
      throw new Error(result.error || 'Checkout failed');
    }
    return result.order;
  }
}
