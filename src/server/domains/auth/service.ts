import { cookies } from 'next/headers';
import type { UserSession, Order, PaymentProvider } from '@/types/index';
import { OrderWriteService } from '@/server/domains/orders/write-service';
import { StorefrontCustomerService } from '@/server/domains/customers/storefront-service';
import { getContainer } from '@/server/di/container';

export const SESSION_COOKIE = 'omni_session';

export class AuthService {
  static async createSession(
    role: 'super_admin' | 'admin' | 'manager' | 'customer',
    email: string,
    name: string,
    phone: string,
  ): Promise<UserSession> {
    let userId = '';

    if (role === 'customer') {
      const existing =
        (await StorefrontCustomerService.findByEmailOrPhone(email)) ??
        (phone ? await StorefrontCustomerService.findByEmailOrPhone(phone) : null);
      const customer =
        existing ??
        (await StorefrontCustomerService.ensure({ name, email, phone }));
      userId = customer.id;
    } else {
      userId = `usr_${role}`;
    }

    const token = `bff_sec_${Buffer.from(`${userId}:${role}:${Date.now()}`).toString('base64')}`;

    const session: UserSession = {
      userId,
      email,
      name,
      role,
      token,
      createdAt: new Date().toISOString(),
    };

    return getContainer().userSessions.create(session, token);
  }

  static async getSession(token?: string | null): Promise<UserSession | null> {
    if (!token) return null;
    return getContainer().userSessions.findByToken(token);
  }

  static async getSessionFromCookies(): Promise<UserSession | null> {
    const cookieStore = await cookies();
    return this.getSession(cookieStore.get(SESSION_COOKIE)?.value);
  }

  /** @deprecated Prefer OrdersService.createCheckout / OrderWriteService */
  static createOrder(params: {
    userId?: string | null;
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
  }): Promise<{ success: boolean; order?: Order; error?: string }> {
    return OrderWriteService.createOrder(params);
  }
}
