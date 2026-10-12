import type { AccountDraft } from '../chart';
import { INTERNATIONAL_ACCOUNTS, INTERNATIONAL_TEMPLATE } from './international';
import type { ChartTemplate } from './types';

const rename: Record<string, string> = {
  '1410': 'Input VAT (recoverable)',
  '1420': 'Withholding VAT / income tax recoverable',
  '2310': 'Output VAT (payable to KRA)',
  '2320': 'Corporation tax payable',
  '2330': 'PAYE, NSSF, NHIF/SHIF and housing levy payable',
  '1130': 'M-Pesa and mobile money clearing',
};

const extra: AccountDraft[] = [
  {
    no: '1125',
    name: 'M-Pesa paybill settlement account',
    type: 'posting',
    category: 'assets',
    subcategory: null,
    normalBalance: 'debit',
    directPosting: true,
    postingSource: 'engine_only',
    totaling: null,
    indent: 2,
  },
  {
    no: '2340',
    name: 'Excise duty payable',
    type: 'posting',
    category: 'liabilities',
    subcategory: null,
    normalBalance: 'credit',
    directPosting: true,
    postingSource: 'manual',
    totaling: null,
    indent: 2,
  },
  {
    no: '6410',
    name: 'M-Pesa and mobile money charges',
    type: 'posting',
    category: 'expense',
    subcategory: null,
    normalBalance: 'debit',
    directPosting: true,
    postingSource: 'manual',
    totaling: null,
    indent: 1,
  },
];

const accounts: AccountDraft[] = [
  ...INTERNATIONAL_ACCOUNTS.map((a) => ({ ...a, name: rename[a.no] ?? a.name })),
  ...extra,
].sort((a, b) => (a.no < b.no ? -1 : a.no > b.no ? 1 : 0));

/** Kenya: KES, VAT and withholding accounts named for KRA, mobile-money accounts for M-Pesa. */
export const KENYA_TEMPLATE: ChartTemplate = {
  ...INTERNATIONAL_TEMPLATE,
  code: 'kenya',
  name: 'Kenya (KES, KRA VAT, M-Pesa)',
  description:
    'The international chart with KRA-named tax accounts and M-Pesa accounts. A starting point: have a qualified Kenyan accountant review it before go-live.',
  baseCurrency: 'KES',
  fiscalYearStartMonth: 1,
  accounts,
  bankAccounts: [
    { code: 'CASH', name: 'Cash on hand', kind: 'cash', glAccount: '1110' },
    { code: 'BANK', name: 'Main bank account', kind: 'bank', glAccount: '1120', feeAccount: '6400' },
    { code: 'MPESA', name: 'M-Pesa paybill / till settlement', kind: 'mobile_money', glAccount: '1125', feeAccount: '6410' },
    { code: 'MOBILE', name: 'Other mobile money', kind: 'mobile_money', glAccount: '1130', feeAccount: '6410' },
    { code: 'CHQ-TRANSIT', name: 'Cheques in transit', kind: 'clearing', glAccount: '1140' },
  ],
  paymentMethods: [
    { code: 'CASH', name: 'Cash', kind: 'cash', bankAccount: 'CASH', refundDestination: 'manual', sortOrder: 10 },
    { code: 'MPESA', name: 'M-Pesa', kind: 'mobile_money', bankAccount: 'MPESA', requiresReference: true, refundDestination: 'manual', legacyCodes: ['mpesa_daraja', 'kcb_buni'], provider: 'mpesa_daraja', sortOrder: 20 },
    { code: 'BANK_TRANSFER', name: 'Bank transfer (EFT / RTGS / PesaLink)', kind: 'bank_transfer', bankAccount: 'BANK', requiresReference: true, refundDestination: 'manual', sortOrder: 30 },
    { code: 'BANK_DEPOSIT', name: 'Bank deposit slip', kind: 'bank_deposit', bankAccount: 'BANK', requiresReference: true, requiresEvidence: true, sortOrder: 40 },
    { code: 'CHEQUE', name: 'Cheque', kind: 'cheque', bankAccount: 'CHQ-TRANSIT', requiresReference: true, requiresCounterparty: true, requiresEvidence: true, sortOrder: 50 },
    { code: 'CARD', name: 'Card', kind: 'card', bankAccount: 'BANK', requiresReference: true, legacyCodes: ['pesapal_v3'], provider: 'pesapal_v3', sortOrder: 60 },
    { code: 'ONLINE_BANK', name: 'Online bank payment', kind: 'gateway', bankAccount: 'BANK', requiresReference: true, legacyCodes: ['jenga_hq'], provider: 'jenga_hq', sortOrder: 70 },
    { code: 'MOBILE_MONEY', name: 'Other mobile money (Airtel, T-Kash …)', kind: 'mobile_money', bankAccount: 'MOBILE', requiresReference: true, refundDestination: 'manual', sortOrder: 80 },
  ],
};
