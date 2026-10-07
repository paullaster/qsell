import { AuthService } from '@/server/domains/auth/service';
import type { Order, PaymentProvider } from '@/types/index';
import { OrderWriteService } from './write-service';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';

export class OrdersService {
  static async createCheckout(params: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    buyerKraPin?: string | null;
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
    dimensionFields?:
      | Record<string, string | null | undefined>
      | {
          global: Record<string, string>;
          shortcut: Record<string, string>;
        };
  }): Promise<Order> {
    const session = await auth();
    const { organizations, companySettings, branches } = getContainer();
    const company = await companySettings.ensureSeeded();
    const { branch } = await organizations.ensureDefaultOrgAndBranch(
      company.id,
      company.tradingName || company.legalName,
    );
    const sellingBranch = (await branches.getDefault(company.id)) || branch;

    const result = await OrderWriteService.createOrder({
      userId: params.userId || session?.user?.customerStoreId || session?.user?.id || null,
      branchId: sellingBranch.id,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      buyerKraPin: params.buyerKraPin,
      shippingAddress: params.shippingAddress,
      items: params.items,
      currency: params.currency || 'KES',
      paymentMethod: params.paymentMethod,
      dimensionFields: params.dimensionFields,
    });

    if (!result.success || !result.order) {
      throw new Error(result.error || 'Checkout failed');
    }
    return result.order;
  }

  /** @deprecated legacy cookie session path — prefer createCheckout */
  static async createCheckoutLegacy(params: Parameters<typeof OrdersService.createCheckout>[0]) {
    const session = await AuthService.getSessionFromCookies();
    return this.createCheckout({
      ...params,
      userId: params.userId || session?.userId,
    });
  }
}
