import { cookies } from 'next/headers';
import { db } from '@/server/db/store';
import type { UserSession, Order, PaymentProvider } from '@/types/index';
import { OrderWriteService } from '@/server/domains/orders/write-service';

export const SESSION_COOKIE = 'omni_session';

export class AuthService {
  static createSession(
    role: 'super_admin' | 'admin' | 'manager' | 'customer',
    email: string,
    name: string,
    phone: string,
  ): UserSession {
    let userId = '';

    if (role === 'customer') {
      let existingCustomer =
        db.getCustomerByEmailOrPhone(email) || db.getCustomerByEmailOrPhone(phone);
      if (!existingCustomer) {
        existingCustomer = db.createCustomer({
          name,
          email,
          phone,
          role: 'customer',
          status: 'verified',
          addresses: [],
          paymentPreferences: {},
        });
      }
      userId = existingCustomer.id;
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

    db.userSessions.set(token, session);
    return session;
  }

  static getSession(token?: string | null): UserSession | null {
    if (!token) return null;
    return db.userSessions.get(token) || null;
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
