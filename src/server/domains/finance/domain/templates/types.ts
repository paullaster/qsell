import type { AccountDraft } from '../chart';
import type { PaymentMethodKind } from '@/server/db/drizzle/schema';

export interface PostingGroupTemplate {
  code: string;
  name: string;
}

/** A chart template: plain data a company imports once, then owns. */
export interface ChartTemplate {
  code: string;
  name: string;
  description: string;
  version: string;
  baseCurrency: string;
  /** Shape of the fiscal year it suggests (the company can change it). */
  fiscalYearStartMonth: number;
  calendarShape: 'monthly' | 'weeks_445' | 'weeks_454' | 'weeks_544' | 'weeks_13x4';
  accounts: AccountDraft[];
  businessGroups: PostingGroupTemplate[];
  productGroups: PostingGroupTemplate[];
  /** General posting setup: business × product group -> which account each purpose posts to. */
  generalSetup: {
    business: string;
    product: string;
    sales: string;
    salesReturns: string;
    salesDiscount: string;
    cogs: string;
    inventoryAdjustment: string;
    inventory: string;
    inventoryClearing: string;
  }[];
  /** Standard money containers, each pointing at an account number in this chart. */
  bankAccounts: {
    code: string;
    name: string;
    kind: 'bank' | 'cash' | 'mobile_money' | 'clearing';
    glAccount: string;
    feeAccount?: string;
  }[];
  /** Standard ways of paying, each pointing at one of the bank accounts above by code. */
  paymentMethods: {
    code: string;
    name: string;
    kind: PaymentMethodKind;
    bankAccount: string;
    requiresReference?: boolean;
    requiresEvidence?: boolean;
    requiresCounterparty?: boolean;
    refundDestination?: 'none' | 'manual' | 'automatic';
    /** Old provider codes (orders.payment_method) this method stands for. */
    legacyCodes?: string[];
    /** A provider code whose branch account collects for this method. */
    provider?: string;
    sortOrder: number;
  }[];
  customerGroups: {
    code: string;
    name: string;
    receivables: string;
    customerDeposits: string;
    refundsPayable: string;
    paymentDiscount: string;
    writeOff: string;
    rounding: string;
    fxGain: string;
    fxLoss: string;
    serviceCharge: string;
    rebateExpense: string;
    giftCardLiability: string;
    loyaltyProvision: string;
    creditForfeit: string;
    creditAdjustment: string;
  }[];
  /** Where tax charged on sales is owed. */
  outputTaxAccount: string;
}
