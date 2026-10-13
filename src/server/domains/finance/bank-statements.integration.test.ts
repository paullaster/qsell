import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('bank statements (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let fin: import('./index').FinanceServices;
  let companyId: string;
  let glBank: string;
  let glFee: string;
  let ctx: import('./errors').FinanceContext;
  const run = randomUUID().slice(0, 6).toUpperCase();
  let seq = 0;
  const origin = { surface: 'test', action: 'run' };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const day = (back: number) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10);
  const dmy = (iso: string) => iso.split('-').reverse().join('/');

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e) return String((e as { code: unknown }).code);
      return `OTHER:${(e as Error).message}`;
    }
  };
  const dbError = async (p: PromiseLike<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return ((e as { cause?: Error }).cause ?? (e as Error)).message;
    }
  };
  const map = { headerRow: 1, date: 'Date', description: ['Narration'], reference: 'Ref', paidIn: 'In', withdrawn: 'Out', balance: 'Balance' };
  const csv = (rows: [string, string, string, string, string, string][]) => `Date,Narration,Ref,In,Out,Balance\n${rows.map((r) => r.join(',')).join('\n')}`;

  /** A bank account of its own, with a method paying into it, so tests do not share state. */
  async function fresh(label: string) {
    seq += 1;
    const account = await fin.bankAccounts.create(ctx, { code: `ST${run}${seq}`, name: `Statement test ${label}`, kind: 'bank', currency: 'KES', glAccountId: glBank, feeGlAccountId: glFee });
    const method = await fin.paymentMethods.create(ctx, { code: `STM${run}${seq}`, name: `Transfer ${seq}`, kind: 'bank_transfer', balancingBankAccountId: account.id, usableFor: ['customer_receipt'], refundDestination: 'none' });
    return { account, method };
  }
  async function customer(name = 'Stmt customer') {
    seq += 1;
    const [c] = await db.insert(schema.customers).values({ companyId, number: `SC${run}${seq}`, name: `${name} ${seq}`, phone: `0722${String(100000 + seq)}`, accountType: 'cash', creditLimit: '0' }).returning();
    return c!;
  }
  /** A receipt that put `amount` into the account, quoting `ref`: a ledger entry we expect to see on the statement. */
  async function receipt(f: { account: { id: string }; method: { id: string } }, amount: string, on: string, ref: string | null) {
    const c = await customer();
    const r = await fin.receipts.create(ctx, { customerId: c.id, paymentMethodId: f.method.id, amount, paymentDate: on, postingDate: on, externalReference: ref ?? `AUTO${seq}${Math.floor(Math.random() * 1e6)}` });
    await fin.receipts.post(ctx, r.id, { allocate: 'none' });
    const [e] = await db.select().from(schema.bankLedgerEntries).where(and(eq(schema.bankLedgerEntries.documentId, r.id), eq(schema.bankLedgerEntries.bankAccountId, f.account.id)));
    return { ...r, entry: e!, customer: c };
  }
  const lines = (accountId: string) => db.select().from(schema.bankStatementLines).where(eq(schema.bankStatementLines.bankAccountId, accountId)).orderBy(schema.bankStatementLines.id);
  const importCsv = (accountId: string, rows: [string, string, string, string, string, string][], name = `s${Math.random()}.csv`) =>
    fin.bankStatements.import(ctx, { bankAccountId: accountId, fileName: name, text: csv(rows), format: 'csv', mapping: map, saveFormat: true });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const c = getContainer();
    fin = c.finance;
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'ST', tradingName: 'ST', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    companyId = company!.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    await fin.paymentMethods.seedStandard(ctx);
    const accts = await fin.setup.listAccounts(companyId);
    glBank = (await fin.bankAccounts.list(companyId)).find((b) => b.account.kind === 'bank')!.account.glAccountId;
    glFee = accts.find((a) => a.category === 'expense' && a.type === 'posting')!.id;
  });

  describe('importing', () => {
    it('reads the file, keeps every line, and refuses the same file twice', async () => {
      const f = await fresh('import');
      const rows: [string, string, string, string, string, string][] = [
        [dmy(day(3)), 'Deposit A', 'REFAAA1', '1000.00', '', '1000.00'],
        [dmy(day(2)), 'Withdrawal', 'REFBBB2', '', '250.00', '750.00'],
      ];
      const r = await importCsv(f.account.id, rows, 'oct.csv');
      expect(r).toMatchObject({ lines: 2, duplicates: 0, balanceBreaks: 0 });
      const ls = await lines(f.account.id);
      expect(ls.map((l) => [l.amount, l.status])).toEqual([['1000.0000', 'unmatched'], ['-250.0000', 'unmatched']]);
      const [imp] = await db.select().from(schema.bankStatementImports).where(eq(schema.bankStatementImports.bankAccountId, f.account.id));
      expect(imp).toMatchObject({ openingBalance: '0.0000', closingBalance: '750.0000', totalIn: '1000.0000', totalOut: '250.0000' });
      expect(await codeOf(importCsv(f.account.id, rows, 'oct-again.csv'))).toBe('ALREADY_IMPORTED');
      expect((await fin.bankStatements.getFormat(companyId, f.account.id))?.kind).toBe('csv');
    });

    it('an overlapping file adds only the new lines; a file of only old lines is refused', async () => {
      const f = await fresh('overlap');
      const a: [string, string, string, string, string, string] = [dmy(day(5)), 'One', 'R1ONE', '100.00', '', '100.00'];
      const b: [string, string, string, string, string, string] = [dmy(day(4)), 'Two', 'R2TWO', '200.00', '', '300.00'];
      const c: [string, string, string, string, string, string] = [dmy(day(3)), 'Three', 'R3THREE', '300.00', '', '600.00'];
      await importCsv(f.account.id, [a, b]);
      const r = await importCsv(f.account.id, [b, c]);
      expect(r).toMatchObject({ lines: 1, duplicates: 1 });
      expect(await lines(f.account.id)).toHaveLength(3);
      expect(await codeOf(importCsv(f.account.id, [a]))).toBe('NOTHING_NEW');
    });

    it('two identical real lines in one file are both kept', async () => {
      const f = await fresh('twins');
      const l: [string, string, string, string, string, string] = [dmy(day(2)), 'Same fee', '', '', '10.00', ''];
      await importCsv(f.account.id, [l, l]);
      expect(await lines(f.account.id)).toHaveLength(2);
    });

    it('refuses what it cannot read or what looks wrong, and says why', async () => {
      const f = await fresh('bad');
      expect(await codeOf(importCsv(f.account.id, [['soon', 'x', '', '5.00', '', '']]))).toBe('STATEMENT_UNREADABLE');
      expect(await codeOf(importCsv(f.account.id, [[dmy(day(-30)), 'Future', 'F1', '5.00', '', '']]))).toBe('FUTURE_DATES');
      expect(await codeOf(fin.bankStatements.import(ctx, { bankAccountId: f.account.id, fileName: 'x.csv', text: 'a,b', format: 'csv' }))).toBe('MAPPING_REQUIRED');
      const clearing = (await fin.bankAccounts.list(companyId)).find((b) => b.account.kind === 'clearing')!.account.id;
      expect(await codeOf(importCsv(clearing, [[dmy(day(2)), 'x', 'X1', '5.00', '', '']]))).toBe('ACCOUNT_KIND');
      expect(await lines(f.account.id)).toHaveLength(0);
    });

    it('notices when the running balance does not follow', async () => {
      const f = await fresh('break');
      const r = await importCsv(f.account.id, [[dmy(day(3)), 'a', 'B1', '100.00', '', '100.00'], [dmy(day(2)), 'b', 'B2', '50.00', '', '999.00']]);
      expect(r.balanceBreaks).toBe(1);
    });

    it('reads MT940', async () => {
      const f = await fresh('mt940');
      const yy = (d: string) => d.slice(2).replace(/-/g, '');
      const r = await fin.bankStatements.import(ctx, { bankAccountId: f.account.id, fileName: 'a.sta', format: 'mt940', text: `:20:X\n:60F:C${yy(day(4))}KES0,00\n:61:${yy(day(3))}C400,00NTRFMTREF1//BK1\n:86:From Jane\n:62F:C${yy(day(3))}KES400,00\n` });
      expect(r.lines).toBe(1);
      expect((await lines(f.account.id))[0]).toMatchObject({ amount: '400.0000', description: 'From Jane' });
    });
  });

  describe('matching', () => {
    it('a line quoting our receipt reference is matched on import; a same-amount line without it is only suggested', async () => {
      const f = await fresh('auto');
      const r1 = await receipt(f, '1500', day(3), 'MPS1ABC2D3');
      const r2 = await receipt(f, '700', day(2), 'MPS9ZZZ9ZZ');
      const imp = await importCsv(f.account.id, [
        [dmy(day(2)), 'Funds received MPS1ABC2D3 JANE', 'MPS1ABC2D3', '1500.00', '', '1500.00'],
        [dmy(day(2)), 'Deposit unknown', 'XQ77', '700.00', '', '2200.00'],
      ]);
      expect(imp).toMatchObject({ autoMatched: 1, proposed: 1 });
      const [a, b] = await lines(f.account.id);
      expect(a).toMatchObject({ status: 'matched', matchRule: 'auto:reference' });
      expect(b).toMatchObject({ status: 'proposed', matchRule: 'amount_date', proposedEntryIds: [r2.entry.id] });
      void r1;
      // a human confirms the suggestion
      await fin.bankStatements.matchLine(ctx, b!.id, [r2.entry.id]);
      expect((await lines(f.account.id))[1]!.status).toBe('matched');
    });

    it('amounts must add up exactly; a line can close several entries; an entry closes against one line only', async () => {
      const f = await fresh('manual');
      const e1 = await receipt(f, '100', day(3), null);
      const e2 = await receipt(f, '250', day(3), null);
      const e3 = await receipt(f, '999', day(3), null);
      await importCsv(f.account.id, [
        [dmy(day(2)), 'Bulk deposit', 'BD1', '350.00', '', '350.00'],
        [dmy(day(2)), 'Other deposit', 'BD2', '999.00', '', '1349.00'],
        [dmy(day(1)), 'Another', 'BD3', '999.00', '', '2348.00'],
      ]);
      const [bulk, other, another] = await lines(f.account.id);
      expect(await codeOf(fin.bankStatements.matchLine(ctx, bulk!.id, [e1.entry.id]))).toBe('AMOUNT_MISMATCH');
      await fin.bankStatements.matchLine(ctx, bulk!.id, [e1.entry.id, e2.entry.id]);
      expect(await codeOf(fin.bankStatements.matchLine(ctx, bulk!.id, [e3.entry.id]))).toBe('LINE_MATCHED');
      await fin.bankStatements.matchLine(ctx, other!.id, [e3.entry.id]);
      expect(await codeOf(fin.bankStatements.matchLine(ctx, another!.id, [e3.entry.id]))).toBe('ENTRY_TAKEN');
      const other2 = await fresh('other');
      const foreign = await receipt(other2, '999', day(2), null);
      expect(await codeOf(fin.bankStatements.matchLine(ctx, another!.id, [foreign.entry.id]))).toBe('WRONG_ACCOUNT');
    });

    it('two people matching the same entry at once: exactly one wins', async () => {
      const f = await fresh('race');
      const e = await receipt(f, '321', day(2), null);
      await importCsv(f.account.id, [[dmy(day(2)), 'x', 'RC1', '321.00', '', '321.00'], [dmy(day(2)), 'y', 'RC2', '321.00', '', '642.00']]);
      const [l1, l2] = await lines(f.account.id);
      await db.update(schema.bankStatementLines).set({ status: 'unmatched', proposedEntryIds: [] }).where(eq(schema.bankStatementLines.bankAccountId, f.account.id));
      const out = await Promise.all([codeOf(fin.bankStatements.matchLine(ctx, l1!.id, [e.entry.id])), codeOf(fin.bankStatements.matchLine(ctx, l2!.id, [e.entry.id]))]);
      expect(out.sort()).toEqual(['ENTRY_TAKEN', 'OK']);
    });

    it('undoing a match needs a reason and keeps the history', async () => {
      const f = await fresh('undo');
      const e = await receipt(f, '88', day(2), 'UNDO12345');
      await importCsv(f.account.id, [[dmy(day(2)), 'UNDO12345', 'UNDO12345', '88.00', '', '88.00']]);
      const [l] = await lines(f.account.id);
      expect(l!.status).toBe('matched');
      expect(await codeOf(fin.bankStatements.unmatchLine(ctx, l!.id, { code: '' }))).toBe('REASON_REQUIRED');
      await fin.bankStatements.unmatchLine(ctx, l!.id, { code: 'DATA_ENTRY_ERROR' });
      expect((await lines(f.account.id))[0]!.status).toBe('unmatched');
      const history = await db.select().from(schema.bankStatementMatches).where(eq(schema.bankStatementMatches.lineId, l!.id));
      expect(history).toHaveLength(1);
      expect(history[0]!.undoneAt).not.toBeNull();
      await expect(db.delete(schema.bankStatementMatches).where(eq(schema.bankStatementMatches.lineId, l!.id))).rejects.toThrow();
      await fin.bankStatements.matchLine(ctx, l!.id, [e.entry.id]);
      expect((await lines(f.account.id))[0]!.status).toBe('matched');
    });

    it('set aside needs a reason, can be brought back, and only an unmatched line can be set aside', async () => {
      const f = await fresh('ignore');
      await importCsv(f.account.id, [[dmy(day(2)), 'Odd', 'ODD1', '5.00', '', '5.00']]);
      const [l] = await lines(f.account.id);
      expect(await codeOf(fin.bankStatements.ignoreLine(ctx, l!.id, { code: '' }))).toBe('REASON_REQUIRED');
      await fin.bankStatements.ignoreLine(ctx, l!.id, { code: 'OTHER', text: 'Test deposit by the bank' });
      expect((await lines(f.account.id))[0]).toMatchObject({ status: 'ignored', ignoreReason: 'OTHER: Test deposit by the bank' });
      expect(await codeOf(fin.bankStatements.matchLine(ctx, l!.id, [1]))).toBe('LINE_IGNORED');
      await fin.bankStatements.restoreLine(ctx, l!.id);
      expect((await lines(f.account.id))[0]!.status).toBe('unmatched');
    });
  });

  describe('turning a line into a record', () => {
    it('an unrecorded deposit becomes a posted receipt and the line closes against it; retrying changes nothing', async () => {
      const f = await fresh('mkreceipt');
      const c = await customer('Depositor');
      await importCsv(f.account.id, [[dmy(day(1)), 'Paid by Depositor', 'DEP-77', '2500.00', '', '2500.00']]);
      const [l] = await lines(f.account.id);
      const out = await fin.bankStatements.createReceiptFromLine(ctx, l!.id, { customerId: c.id, paymentMethodId: f.method.id, allocate: 'none' });
      expect((await lines(f.account.id))[0]).toMatchObject({ status: 'matched', matchRule: 'created_receipt' });
      const [rc] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.id, out.receiptId));
      expect(rc).toMatchObject({ status: 'posted', amount: '2500.00', externalReference: 'DEP-77', source: 'bank_statement', paymentDate: day(1) });
      expect(await codeOf(fin.bankStatements.createReceiptFromLine(ctx, l!.id, { customerId: c.id, paymentMethodId: f.method.id }))).toBe('LINE_CLOSED');
      expect(await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.sourceRef, `statement_line:${l!.id}`))).toHaveLength(1);
    });

    it('money out cannot become a receipt, and a method of another account is refused', async () => {
      const f = await fresh('mkreceipt2');
      const g = await fresh('mkreceipt3');
      const c = await customer();
      await importCsv(f.account.id, [[dmy(day(1)), 'Out', 'OUT1', '', '40.00', ''], [dmy(day(1)), 'In', 'IN1', '41.00', '', '']]);
      const [out, inn] = await lines(f.account.id);
      expect(await codeOf(fin.bankStatements.createReceiptFromLine(ctx, out!.id, { customerId: c.id, paymentMethodId: f.method.id }))).toBe('NOT_A_DEPOSIT');
      expect(await codeOf(fin.bankStatements.createReceiptFromLine(ctx, inn!.id, { customerId: c.id, paymentMethodId: g.method.id }))).toBe('METHOD_ACCOUNT');
    });

    it('a bank charge is recorded against the fee account and the line closes; deposits are not charges', async () => {
      const f = await fresh('charge');
      await importCsv(f.account.id, [[dmy(day(1)), 'SMS alert fee', 'FEE1', '', '33.00', ''], [dmy(day(1)), 'Dep', 'D1', '9.00', '', '']]);
      const [fee, dep] = await lines(f.account.id);
      expect(await codeOf(fin.bankStatements.recordChargeFromLine(ctx, dep!.id))).toBe('NOT_A_CHARGE');
      const r = await fin.bankStatements.recordChargeFromLine(ctx, fee!.id);
      expect(r.number).toMatch(/^BCH-/);
      expect((await lines(f.account.id))[0]).toMatchObject({ status: 'matched', matchRule: 'recorded_charge' });
      const [e] = await db.select().from(schema.bankLedgerEntries).where(and(eq(schema.bankLedgerEntries.bankAccountId, f.account.id), eq(schema.bankLedgerEntries.documentType, 'bank_charge')));
      expect(e).toMatchObject({ amount: '-33.0000' });
      await db.update(schema.bankAccounts).set({ feeGlAccountId: null }).where(eq(schema.bankAccounts.id, f.account.id));
      await importCsv(f.account.id, [[dmy(day(1)), 'Another fee', 'FEE2', '', '5.00', '']], 'fee2.csv');
      const [, , fee2] = await lines(f.account.id);
      expect(await codeOf(fin.bankStatements.recordChargeFromLine(ctx, fee2!.id))).toBe('NO_FEE_ACCOUNT');
    });
  });

  describe('reconciling', () => {
    it('is blocked by lines not dealt with, and by a sum that does not agree, in words', async () => {
      const f = await fresh('rec1');
      await receipt(f, '1000', day(3), 'REC1AAAAA');
      await importCsv(f.account.id, [[dmy(day(3)), 'REC1AAAAA', 'REC1AAAAA', '1000.00', '', '1000.00'], [dmy(day(2)), 'Mystery', 'MYS1', '40.00', '', '1040.00']]);
      const base = { bankAccountId: f.account.id, statementDate: day(2), statementBalance: '1040.00', openingBalance: '0' };
      expect(await codeOf(fin.bankReconciliation.post(ctx, base))).toBe('LINES_OPEN');
      const [, mystery] = await lines(f.account.id);
      await fin.bankStatements.ignoreLine(ctx, mystery!.id, { code: 'OTHER', text: 'bank error, reversed next week' });
      expect(await codeOf(fin.bankReconciliation.post(ctx, { ...base, openingBalance: undefined }))).toBe('OPENING_REQUIRED');
      const wrong = await fin.bankReconciliation.post(ctx, { ...base, statementBalance: '1030.00' }).catch((e: Error & { code?: string }) => e);
      expect((wrong as { code: string }).code).toBe('DIFFERENCE');
      expect((wrong as Error).message).toMatch(/difference is -10\.00/);
      expect(await codeOf(fin.bankReconciliation.post(ctx, { ...base, statementDate: day(-1) }))).toBe('DATE_INVALID');
    });

    it('posts when it agrees, locks the lines, chains from the previous one, and only the latest can be reversed', async () => {
      const f = await fresh('rec2');
      await receipt(f, '1000', day(5), 'REC2AAAAA');
      await receipt(f, '500', day(2), 'REC2BBBBB');
      await importCsv(f.account.id, [[dmy(day(5)), 'REC2AAAAA', 'REC2AAAAA', '1000.00', '', '1000.00'], [dmy(day(2)), 'REC2BBBBB', 'REC2BBBBB', '500.00', '', '1500.00']]);
      const first = await fin.bankReconciliation.post(ctx, { bankAccountId: f.account.id, statementDate: day(4), statementBalance: '1000.00', openingBalance: '0' });
      expect(first.lines).toBe(1);
      const [l1, l2] = await lines(f.account.id);
      expect(l1!.reconciliationId).toBe(first.id);
      expect(l2!.reconciliationId).toBeNull();
      // a closed line cannot be touched, even straight in the database
      expect(await dbError(db.update(schema.bankStatementLines).set({ status: 'unmatched' }).where(eq(schema.bankStatementLines.id, l1!.id)))).toMatch(/reconciled/);
      expect(await codeOf(fin.bankStatements.unmatchLine(ctx, l1!.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('LINE_RECONCILED');
      expect(await codeOf(fin.bankStatements.ignoreLine(ctx, l1!.id, { code: 'OTHER', text: 'x' }))).toBe('LINE_RECONCILED');
      // the next one starts from the last statement balance, no opening needed
      expect(await codeOf(fin.bankReconciliation.post(ctx, { bankAccountId: f.account.id, statementDate: day(5), statementBalance: '1000.00' }))).toBe('BEFORE_PREVIOUS');
      expect((await fin.bankReconciliation.preview(companyId, f.account.id, day(2))).previous).toMatchObject({ balance: '1000.0000' });
      const second = await fin.bankReconciliation.post(ctx, { bankAccountId: f.account.id, statementDate: day(2), statementBalance: '1500.00' });
      expect(await codeOf(fin.bankReconciliation.post(ctx, { bankAccountId: f.account.id, statementDate: day(2), statementBalance: '1500.00' }))).toBe('NO_LINES');
      expect(await codeOf(fin.bankReconciliation.reverse(ctx, first.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('NOT_LATEST');
      await fin.bankReconciliation.reverse(ctx, second.id, { code: 'DATA_ENTRY_ERROR' });
      expect((await lines(f.account.id))[1]!.reconciliationId).toBeNull();
      expect(await codeOf(fin.bankReconciliation.reverse(ctx, second.id, { code: 'DATA_ENTRY_ERROR' }))).toBe('ALREADY_REVERSED');
      await expect(db.update(schema.bankReconciliations).set({ statementBalance: '1.00' }).where(eq(schema.bankReconciliations.id, first.id))).rejects.toThrow();
      await expect(db.delete(schema.bankReconciliations).where(eq(schema.bankReconciliations.id, first.id))).rejects.toThrow();
      const [num] = await db.select().from(schema.bankReconciliations).where(eq(schema.bankReconciliations.id, first.id));
      expect(num!.number).toMatch(/^BRC-/);
      await expect(db.update(schema.bankStatementLines).set({ amount: '1' }).where(eq(schema.bankStatementLines.id, l2!.id))).rejects.toThrow();
      await expect(db.delete(schema.bankStatementLines).where(eq(schema.bankStatementLines.id, l2!.id))).rejects.toThrow();
      await expect(db.update(schema.bankStatementImports).set({ fileName: 'x' }).where(eq(schema.bankStatementImports.bankAccountId, f.account.id))).rejects.toThrow();
    });

    it('shows the proof: book balance, what is outstanding, and what the books carry', async () => {
      const f = await fresh('rec3');
      await receipt(f, '600', day(3), 'REC3AAAAA');
      await receipt(f, '400', day(2), 'REC3BBBBB'); // not on the statement yet: outstanding
      await importCsv(f.account.id, [[dmy(day(3)), 'REC3AAAAA', 'REC3AAAAA', '600.00', '', '600.00']]);
      const p = await fin.bankReconciliation.preview(companyId, f.account.id, day(1));
      expect(p).toMatchObject({ bookBalance: '1000.0000', outstandingNet: '400.0000', outstandingCount: 1, lineCount: 1, blockingCount: 0, suggestedStatementBalance: '600.0000', needsOpening: true });
      const o = (await fin.bankStatements.overview(companyId)).find((r) => r.id === f.account.id)!;
      expect(o).toMatchObject({ unmatched: 0, outstanding: 1, matched_open: 1 });
    });
  });

  describe('refunds paid are seen on the statement', () => {
    it('matching the payout marks the refund as seen by the bank, and undoing it clears that', async () => {
      const f = await fresh('refund');
      const c = await customer('Refunded');
      const refundId = randomUUID();
      await db.insert(schema.refundRequests).values({
        id: refundId, companyId, number: `RFD-ST-${run}`, customerId: c.id, sourceKind: 'credit_note_excess', sourceId: randomUUID(), currency: 'KES', amount: '580', reasonCode: 'CUSTOMER_REQUEST',
        paymentMethodId: f.method.id, payoutDetails: {}, requestedBy: 'tester', status: 'paid', payoutReference: 'RFDPAY777', paidAt: new Date(),
      });
      const [entry] = await db.insert(schema.bankLedgerEntries).values({ companyId, bankAccountId: f.account.id, postingDate: day(2), documentType: 'refund', documentNo: `RFD-ST-${run}`, documentId: refundId, description: 'Refund', amount: '-580', currency: 'KES' }).returning();
      const imp = await importCsv(f.account.id, [[dmy(day(1)), 'Paid out RFDPAY777 to customer', 'RFDPAY777', '', '580.00', '']]);
      expect(imp.autoMatched).toBe(1);
      const seen = async () => (await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.id, refundId)))[0]!.bankMatchedAt;
      expect(await seen()).not.toBeNull();
      const [l] = await lines(f.account.id);
      await fin.bankStatements.unmatchLine(ctx, l!.id, { code: 'DATA_ENTRY_ERROR' });
      expect(await seen()).toBeNull();
      const ev = await db.select().from(schema.refundEvents).where(eq(schema.refundEvents.refundId, refundId));
      expect(ev.map((x) => x.event)).toEqual(['bank_matched', 'bank_unmatched']);
      void entry;
    });
  });

  describe('once the books are live', () => {
    it('a charge from a statement line posts to the general ledger and the reconciliation still agrees', async () => {
      await fin.salesPosting.goLive(ctx, { offsetAccountId: (await fin.setup.listAccounts(companyId)).find((a) => a.no === '3100')!.id });
      const f = await fresh('live');
      await importCsv(f.account.id, [[dmy(day(0)), 'Monthly ledger fee', 'LF1', '', '150.00', '']]);
      const [l] = await lines(f.account.id);
      const out = await fin.bankStatements.recordChargeFromLine(ctx, l!.id);
      expect(out.gl).toBe(true);
      const [e] = await db.select().from(schema.bankLedgerEntries).where(and(eq(schema.bankLedgerEntries.bankAccountId, f.account.id), eq(schema.bankLedgerEntries.documentType, 'bank_charge')));
      expect(e!.registerId).not.toBeNull();
      const gl = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, e!.registerId!));
      expect(gl.reduce((n, x) => n + Number(x.debit), 0)).toBe(150);
      expect(gl.reduce((n, x) => n + Number(x.credit), 0)).toBe(150);
      expect(gl.find((x) => x.accountId === glFee && Number(x.debit) === 150)).toBeTruthy();
      expect((await fin.salesPosting.reconciliation(companyId)).rows.map((r) => r.diffCents)).toEqual([0]);
      void sql;
    });
  });
});
