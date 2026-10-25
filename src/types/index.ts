import type { PriceTrace } from '@/server/domains/pricing/domain/types';

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  imageUrl?: string;
  isActive: boolean;
  displayOrder: number;
  /** The category this sits under, or null for a top-level one. */
  parentId?: string | null;
  /** "Shoes › Running": the names from the top down. Filled in when categories are listed. */
  path?: string;
  /** 0 for a top-level category, 1 for its sub-categories, and so on. */
  depth?: number;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** User-defined item classification (raw material, finished good, etc.). */
export interface ItemType {
  id: string;
  /** Integer code from the tax authority (tax compliance / e-invoicing) */
  code: number;
  name: string;
  isSellable: boolean;
  isDefault: boolean;
  isActive: boolean;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSpecification {
  key: string;
  value: string;
}

export interface Product {
  id: string;
  sku: string;
  /** Internal stock-control identifier; distinct from the customer-facing SKU. */
  stockCode: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  brand?: string;
  itemTypeId: string;
  itemTypeName: string;
  itemTypeCode: number;
  /** Denormalized from item type — storefront uses this to hide non-sellable items */
  isSellable: boolean;
  /** Required when item type is sellable; omit/null when not sellable */
  price?: number;
  compareAtPrice?: number;
  /** Required unit cost of goods (form defaults empty until set) */
  costPrice: number;
  taxCategoryId?: string;
  taxCategoryName?: string;
  taxRate?: number;
  isTaxInclusive?: boolean;
  /** Shipping weight of one base unit, in kg. */
  weight?: number;
  /** The unit stock is counted in (kg for fish, pieces for a phone). */
  baseUnitId: string;
  baseUnitCode: string;
  baseUnitName: string;
  /** Digits after the point a quantity of this product may have. */
  baseUnitDecimals: number;
  specifications?: ProductSpecification[];
  stockQuantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
  isActive: boolean;
  imageUrl: string;
  additionalImages?: string[];
  rating: number;
  reviewCount: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Ordered gallery (first is primary). Loaded on single-product staff reads only. */
  media?: ProductMediaItem[];
}

/** A media-library asset as the UI sees it. Private assets expose the authorised route, never a provider URL. */
export interface MediaAssetView {
  id: string;
  provider: 's3' | 'local' | 'cloudinary' | 'external';
  visibility: 'public' | 'private';
  purpose: string;
  url: string;
  thumbUrl: string;
  mime: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  altText: string;
  originalName: string;
  status: 'pending' | 'ready';
  createdAt: string;
}

/** What the product form sends for each gallery slot; the first slot is the primary image. */
export interface ProductMediaInput {
  assetId: string;
  /** Per-product alt text. Empty/absent falls back to the asset's own. */
  altText?: string;
}

/** A gallery slot as read back: the input plus what is needed to render it. */
export interface ProductMediaItem extends ProductMediaInput {
  url: string;
  thumbUrl: string;
  /** The text screen readers get: this product's override, else the asset's. */
  altText: string;
  originalName: string;
  provider: 's3' | 'local' | 'cloudinary' | 'external';
  width: number | null;
  height: number | null;
  isPrimary: boolean;
  /** Client-only: uploaded or linked in this form and not saved yet, so it can be discarded safely. */
  pending?: boolean;
}

/** A product as accepted by create: the gallery is given as asset references. */
export type ProductWrite = Omit<
  Product,
  'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity' | 'media' | 'baseUnitId' | 'baseUnitCode' | 'baseUnitName' | 'baseUnitDecimals'
> & {
  media?: ProductMediaInput[];
  /** Left out: the default unit of measure. */
  baseUnitId?: string;
  /** The other units the product is kept, bought or sold in. */
  packagings?: ProductPackagingInput[];
};

/** One alternate unit of a product as the form sends it. */
export interface ProductPackagingInput {
  unitId: string;
  qtyPerBase: string;
  weightKg: string;
  isSalesDefault: boolean;
  isPurchaseDefault: boolean;
}

/** A partial product as accepted by update. Omit `media` to leave the gallery untouched. */
export type ProductPatch = Partial<Omit<Product, 'media' | 'baseUnitCode' | 'baseUnitName' | 'baseUnitDecimals'>> & {
  media?: ProductMediaInput[];
  /** Omit to leave the alternate units alone; send the full list to replace them. */
  packagings?: ProductPackagingInput[];
};

/**
 * What the public storefront may see. Unit cost (margin) is staff-only, so it is
 * removed on the server and absent from the type, not merely unused by the UI.
 */
export type PublicProduct = Omit<Product, 'costPrice'>;

export type TaxType =
  'vat' | 'sales_tax' | 'gst' | 'excise' | 'custom' | 'exempt' | 'digital_service';

export interface TaxCategory {
  id: string;
  name: string;
  code: string;
  rate: number; // percentage (e.g. 16 for 16%)
  timsCode: string; // KRA TIMS VAT class, '' when not mapped
  etimsCode: string; // KRA eTIMS tax type code, '' when not mapped
  type: TaxType;
  countryCode: string;
  countryName: string;
  description: string;
  isInclusive: boolean; // whether selling prices are inclusive of this tax
  isDefault: boolean;
  isActive: boolean;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CurrencyConfig {
  code: string; // e.g. "KES", "USD", "EUR", "GBP", "UGX", "TZS", "ZAR", "AED"
  name: string;
  symbol: string;
  exchangeRate: number; // multiplier against store base currency
  isBaseCurrency: boolean;
  decimalDigits: number;
  symbolPosition: 'prefix' | 'suffix';
  isEnabled: boolean;
  flagEmoji?: string;
  updatedAt: string;
}

export type InventoryChangeType =
  | 'purchase_order_receipt'
  | 'purchase_receipt_reversal'
  | 'purchase_return'
  | 'damage_writeoff'
  | 'loss_shrinkage'
  | 'physical_audit'
  | 'order_reservation'
  | 'order_fulfillment'
  | 'restock'
  | 'manual_adjustment'
  | 'reconciliation_correction'
  | 'order_cancellation_release'
  | 'product_deleted';

export interface InventoryLedgerEntry {
  id: string;
  productId: string;
  productName: string;
  changeAmount: number;
  previousStock: number;
  newStock: number;
  changeType: InventoryChangeType;
  referenceId: string;
  actor: string;
  note: string;
  timestamp: string;
}

export type PaymentProvider =
  'mpesa_daraja' | 'pesapal_v3' | 'jenga_hq' | 'kcb_buni' | 'card_direct' | 'on_account';

export interface PaymentGatewayConfig {
  id: string;
  provider: PaymentProvider;
  name: string;
  isEnabled: boolean;
  environment: 'sandbox' | 'production';
  credentials: {
    consumerKey?: string;
    consumerSecret?: string;
    passkey?: string;
    shortcode?: string;
    ipnId?: string;
    accountReference?: string;
  };
  supportedCurrencies: string[];
  icon: string;
  description: string;
}

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refunded';
export type PaymentStatus =
  'unpaid' | 'pending_verification' | 'paid' | 'reconciled' | 'discrepancy' | 'failed';

export interface OrderItem {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  imageUrl: string;
  /** Why the unit price is what it is (the pricing engine's trace). Absent on older orders. */
  priceTrace?: PriceTrace | null;
  /** A free gift added by a promotion. */
  isGift?: boolean;
  /** What one unit cost when it was sold. Absent on older orders. */
  unitCost?: number | null;
  /**
   * `quantity` is always in the product's base unit. When the line was typed in another unit of the
   * product (3 crates), these say so; the order's amounts are unchanged by it.
   */
  unitId?: string | null;
  unitCode?: string | null;
  enteredQuantity?: number | null;
  qtyPerUnit?: string | null;
  enteredUnitPrice?: number | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  userId: string;
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
  items: OrderItem[];
  subtotal: number;
  tax: number;
  shippingFee: number;
  totalAmount: number;
  currency: 'KES' | 'USD';
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentProvider;
  shippingCourier?: string;
  trackingNumber?: string;
  internalNotes?: string;
  shippedAt?: string;
  deliveredAt?: string;
  transactionReference?: string;
  mpesaReceiptNumber?: string;
  pesapalTrackingId?: string;
  dimensionSetId?: string | null;
  /** Rebuildable projection: global["1"] → value code, shortcut["5"] → value code */
  dimensionCodes?: {
    global: Record<string, string>;
    shortcut: Record<string, string>;
  };
  tradeCustomerId?: string | null;
  customerAccountType?: 'cash' | 'credit' | null;
  transmitInvoicesToKra?: boolean;
  kraTransmissionStatus?: 'not_applicable' | 'pending' | 'skipped' | 'transmitted' | 'failed';
  /** Waiting for approval, rejected, or reopened for resubmission: the order cannot move on. */
  approvalStatus?: 'none' | 'pending' | 'approved' | 'rejected' | 'draft';
  /** Invoicing module this sale belongs to; decides which signing switch applies. */
  salesModule?: 'ecommerce' | 'sales_order' | 'credit_sale' | 'pos_cash_sale';
  createdAt: string;
  updatedAt: string;
  /** The discounts applied when the order was priced (rules, coupons, amounts). */
  discounts?: Record<string, unknown> | null;
  /** The part paid with gift cards or loyalty points, not through a payment gateway. */
  tenderedAmount?: number;
}

export interface TransactionRecord {
  id: string;
  orderId: string;
  orderNumber: string;
  gatewayProvider: PaymentProvider;
  transactionReference: string;
  externalReference?: string;
  amount: number;
  currency: string;
  status: 'initiated' | 'pending' | 'successful' | 'failed' | 'flagged';
  customerPhone?: string;
  customerEmail?: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
  ipnStatus: 'pending' | 'delivered' | 'failed';
  reconciliationStatus: 'pending' | 'reconciled' | 'discrepancy';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationLog {
  id: string;
  transactionId: string;
  orderId: string;
  orderNumber: string;
  provider: PaymentProvider;
  reconciliationType: 'auto_realtime' | 'scheduled_batch' | 'manual_override';
  orderTotal: number;
  receivedAmount: number;
  discrepancyFound: boolean;
  discrepancyType?: 'none' | 'underpayment' | 'overpayment' | 'status_mismatch' | 'orphan_payment';
  status: 'matched' | 'corrected' | 'flagged_for_review';
  details: string;
  timestamp: string;
}

export interface UserSession {
  userId: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'manager' | 'customer';
  token: string;
  createdAt: string;
}

export interface CustomerAddress {
  id: string;
  label: string; // e.g. "Primary Home", "Nairobi Office", "Warehouse Dispatch"
  recipientName: string;
  recipientPhone: string;
  street: string;
  city: string;
  countyOrState: string;
  postalCode?: string;
  country: string;
  isDefault: boolean;
}

export interface CustomerPaymentPreferences {
  preferredMethod?: PaymentProvider;
  defaultMpesaPhone?: string;
  defaultCardLast4?: string;
}

export interface CustomerAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  /** Postgres trade-customer card id (sell-to). */
  tradeCustomerId?: string;
  /** BC-style customer number on the trade card (e.g. C00001). */
  customerNumber?: string;
  buyerKraPin?: string | null;
  avatarUrl?: string;
  role: 'admin' | 'customer' | 'manager';
  status: 'active' | 'suspended' | 'verified';
  addresses: CustomerAddress[];
  paymentPreferences: CustomerPaymentPreferences;
  totalOrders: number;
  totalSpend: number;
  lastOrderDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile extends CustomerAccount {
  preferredPaymentMethod: PaymentProvider;
}

export interface DashboardAnalytics {
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  reconciliationRate: number;
  activeStockSkus: number;
  lowStockAlertsCount: number;
  todaySalesKes: number;
  salesByPaymentMethod: {
    provider: string;
    name: string;
    amount: number;
    count: number;
    percentage: number;
  }[];
}
