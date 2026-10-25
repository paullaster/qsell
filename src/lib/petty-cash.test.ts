import { describe, expect, it } from 'vitest';
import { checkFloatForm, checkPettyVoucher, floatLow, notEnoughCash, overDaily, overLimit, topUpAmount, type FloatForm, type PettyVoucherForm } from './petty-cash';

const float = (over: Partial<FloatForm> = {}): FloatForm => ({ code: 'PC1', name: 'Front office', bankAccountId: 'b', glAccountId: 'g', custodianId: 'u', floatAmount: '10000', perVoucherLimit: '1000', dailyLimit: '3000', minimumBalance: '2000', ...over });
const voucher = (over: Partial<PettyVoucherForm> = {}): PettyVoucherForm => ({ floatId: 'f', kind: 'expense', payeeName: 'Corner shop', description: 'Tea and sugar', receiptRef: 'R-1', amount: '350', expenseAccountId: 'e', purchaseInvoiceId: '', ...over });

describe('a float', () => {
  it('is checked, with the limits in order', () => {
    expect(checkFloatForm(float())).toEqual({});
    expect(checkFloatForm(float({ dailyLimit: '500' })).dailyLimit).toMatch(/daily limit cannot be less/);
    expect(checkFloatForm(float({ perVoucherLimit: '20000', dailyLimit: '30000' })).perVoucherLimit).toMatch(/more than the float/);
    expect(checkFloatForm(float({ minimumBalance: '10001' })).minimumBalance).toMatch(/cannot be more than the float/);
    expect(Object.keys(checkFloatForm(float({ code: '!', name: ' ', custodianId: '' }))).sort()).toEqual(['code', 'custodianId', 'name']);
  });
});

describe('a voucher', () => {
  it('needs a payee, a reason, a receipt and an account or invoice', () => {
    expect(checkPettyVoucher(voucher())).toEqual({});
    expect(Object.keys(checkPettyVoucher(voucher({ payeeName: '', description: '', receiptRef: '', amount: '0', expenseAccountId: '' }))).sort()).toEqual(['amount', 'description', 'expenseAccountId', 'payeeName', 'receiptRef']);
    expect(checkPettyVoucher(voucher({ kind: 'vendor_invoice', expenseAccountId: '' })).purchaseInvoiceId).toBeDefined();
  });
  it('is refused for its size, the day, a low float and too little cash, in plain words', () => {
    expect(overLimit(100_000, 100_000)).toBeNull();
    expect(overLimit(100_001, 100_000)).toMatch(/at most 1000\.00 on one voucher/);
    expect(overDaily(250_000, 50_000, 300_000)).toBeNull();
    expect(overDaily(250_000, 50_001, 300_000)).toMatch(/daily limit of 3000\.00/);
    expect(floatLow(200_000, 200_000)).toBeNull();
    expect(floatLow(199_999, 200_000)).toMatch(/Top it up first/);
    expect(notEnoughCash(500, 500)).toBeNull();
    expect(notEnoughCash(499, 500)).toMatch(/only 4\.99/);
  });
});

describe('topping up', () => {
  it('brings the balance back to the float and never below nothing', () => {
    expect(topUpAmount(1_000_000, 640_000)).toBe(360_000);
    expect(topUpAmount(1_000_000, 1_000_000)).toBe(0);
    expect(topUpAmount(1_000_000, 1_200_000)).toBe(0);
  });
});
