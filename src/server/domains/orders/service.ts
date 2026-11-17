import { orElse } from '@/lib/values';
import type { CheckoutRefusal } from '@/lib/order-stages';
import type { DeliveryInput } from '@/lib/checkout-input';
import { AuthService } from '@/server/domains/auth/service';
import type { Order, PaymentProvider } from '@/types/index';
import { OrderWriteService } from './write-service';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';

/** A checkout the shop turned down for a reason it wrote for the shopper (out of stock, a missing field...). Safe to show as it is. */
export class CheckoutRefused extends Error {
  constructor(
    message: string,
    /** Why, in the short form the checkout attempt records. */
    readonly code: CheckoutRefusal = 'other',
  ) {
    super(message);
  }
}

export class OrdersService {
  static async createCheckout(params: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    paymentPhone?: string | null;
    /** When the shopper started this checkout (the order's timeline records it). */
    checkoutStartedAt?: Date | null;
    buyerKraPin?: string | null;
    shippingAddress: {
      street: string;
      city: string;
      countyOrState: string;
      postalCode?: string;
      country: string;
    };
    items: { productId: string; quantity: number; package?: { picks: { slotId: string; optionId: string; count: number }[]; note?: string } }[];
    paymentMethod: PaymentProvider;
    couponCodes?: string[];
    delivery?: DeliveryInput;
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
    // The shop knows who is buying only from the session. An email typed into the form proves nothing, so it may neither charge a
    // customer's credit account nor change a registered customer's card; only the signed-in person with that email may.
    const typedEmail = params.customerEmail.trim().toLowerCase();
    const identityVerified = typedEmail !== '' && session?.user.email.trim().toLowerCase() === typedEmail;
    const { organizations, companySettings, branches } = getContainer();
    const company = await companySettings.ensureSeeded();
    const { branch } = await organizations.ensureDefaultOrgAndBranch(
      company.id,
      company.tradingName || company.legalName,
    );
    const sellingBranch = (await branches.getDefault(company.id)) || branch;

    const result = await OrderWriteService.createOrder({
      userId: params.userId || session?.user?.customerStoreId || session?.user?.id || null,
      customerId: session?.user.customerStoreId ?? null,
      checkoutStartedAt: params.checkoutStartedAt ?? null,
      identityVerified,
      branchId: sellingBranch.id,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      paymentPhone: params.paymentPhone,
      buyerKraPin: params.buyerKraPin,
      shippingAddress: params.shippingAddress,
      items: params.items,
      currency: params.currency || 'KES',
      paymentMethod: params.paymentMethod,
      ...(params.couponCodes === undefined ? {} : { couponCodes: params.couponCodes }),
      ...(params.delivery === undefined ? {} : { delivery: { method: params.delivery.method, ...(params.delivery.pickupBranchId === null ? {} : { pickupBranchId: params.delivery.pickupBranchId }), pin: params.delivery.pin, ...(params.delivery.address === null ? {} : { address: params.delivery.address }), recipient: params.delivery.recipient, notes: params.delivery.notes, expectedCharge: params.delivery.expectedCharge, slot: params.delivery.slot } }),
      dimensionFields: params.dimensionFields,
    });

    if (!result.success || !result.order) {
      throw new CheckoutRefused(orElse(result.error, 'Checkout failed'), result.code ?? 'other');
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
