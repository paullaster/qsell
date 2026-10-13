/**
 * Posting throughput check for the finance engine.
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/finance-load.ts [postings] [concurrency] [branches]
 *
 * Point it at a throwaway database built from the migrations. It sets up a company with the
 * Kenya chart, then posts retail-shaped sales (cash, sales, tax; 3 lines) across many branches
 * at the chosen concurrency, and reports latency percentiles and throughput. It finishes by
 * checking that the running balances agree with the ledger and that every hash chain verifies.
 *
 * This measures the engine on this machine and database. It is NOT the 2x-peak gate on a
 * production-sized dataset that the design requires before anything depends on the engine.
 */
import { drizzleDb as db } from '@/server/db/drizzle/client';
import { companySettings } from '@/server/db/drizzle/schema';
import { createFinanceServices } from '@/server/domains/finance';
import { DecisionLog } from '@/server/kernel/decision-log/service';
import { ReasonCodes } from '@/server/kernel/reason-codes/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';

const postings = Number(process.argv[2] ?? 5000);
const concurrency = Number(process.argv[3] ?? 32);
const branches = Number(process.argv[4] ?? 200);

async function main() {
  const finance = createFinanceServices(db, new DecisionLog(db), {
    // This script only posts through the engine; it never numbers a receipt.
    numbering: undefined as unknown as NumberSeriesService,
    reasons: new ReasonCodes(db),
  });
  const [company] = await db
    .insert(companySettings)
    .values({ legalName: 'Load', tradingName: 'Load', email: 'l@x.io', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
    .returning();
  const companyId = company!.id;
  const ctx = { companyId, actor: { type: 'job' as const, id: 'finance-load' }, origin: { surface: 'script', action: 'finance-load' } };
  const year = new Date().getUTCFullYear();
  await finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: `${year}-01-01` });
  const acct = new Map((await finance.setup.listAccounts(companyId)).map((a) => [a.no, a.id]));
  const date = `${year}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(new Date().getUTCDate(), 28)).padStart(2, '0')}`;

  const latencies: number[] = [];
  let next = 0;
  let failed = 0;
  const started = performance.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= postings) return;
      const branch = i % branches;
      const t0 = performance.now();
      try {
        await finance.engine.post({
          companyId,
          idempotencyKey: `load:${i}`,
          postingDate: date,
          documentType: 'pos_sale',
          documentNo: `S-${i}`,
          currency: 'KES',
          rate: '1',
          rateSource: 'base',
          chainKey: `branch-${branch}`,
          origin: ctx.origin,
          postedBy: 'engine',
          lines: [
            { accountId: acct.get('1110')!, debit: '1160.00', credit: '0' },
            { accountId: acct.get('4100')!, debit: '0', credit: '1000.00' },
            { accountId: acct.get('2310')!, debit: '0', credit: '160.00' },
          ],
        });
        latencies.push(performance.now() - t0);
      } catch (e) {
        failed++;
        if (failed <= 3) console.error((e as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]?.toFixed(1);
  console.log(`postings ${latencies.length}/${postings} (failed ${failed}) in ${seconds.toFixed(1)}s = ${(latencies.length / seconds).toFixed(0)}/s`);
  console.log(`latency ms: p50 ${pct(50)}  p95 ${pct(95)}  p99 ${pct(99)}  max ${latencies[latencies.length - 1]?.toFixed(1)}`);
  console.log(`concurrency ${concurrency}, branches (hash chains) ${branches}`);

  const drift = await finance.reports.balanceDrift(companyId, `${year}-01-01`, `${year}-12-31`);
  console.log(`balance drift rows: ${drift.length}`);
  const chains = await finance.reports.verifyChain(companyId, 100000);
  console.log(`chains verified: ${chains.filter((c) => c.ok).length}/${chains.length}`);
  process.exit(failed === 0 && drift.length === 0 && chains.every((c) => c.ok) ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
