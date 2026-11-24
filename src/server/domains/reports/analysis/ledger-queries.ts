import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { fiscalYears, glAccounts, paymentMethods } from '@/server/db/drizzle/schema';
import { compareAccountNo } from '@/server/domains/finance/domain/chart';
import { parseAmount } from '@/server/domains/finance/domain/amount';
import { rows } from '../queries';

/**
 * The ledger reads behind the financial statements. Everything is in the business's base currency and in whole scaled
 * integers (four decimals), so a statement adds up exactly and a proof compares equal numbers, not close ones. Amounts are
 * "net debit": debits minus credits, so a debit balance is positive and a credit balance is negative.
 */

export type Net = bigint;
export type Nets = Map<string, Net>;

export type AccountCategory =
  'assets' | 'liabilities' | 'equity' | 'income' | 'cost_of_sales' | 'expense';

/** A posting account of the company's chart, with the group it sits in as the chart itself draws it. */
export interface ChartAccount {
  id: string;
  no: string;
  name: string;
  category: AccountCategory;
  normal: 'debit' | 'credit';
  /** The heading (or, without one, the section) above the account in the chart: "Receivables", "Equity". */
  group: string;
  /** The order of the group in the chart, so groups print in the chart's order. */
  groupNo: string;
}

/** The first of these that is not empty. */
function firstFilled(...values: string[]): string {
  return values.find((v) => v !== '') ?? '';
}

const CATEGORIES: readonly AccountCategory[] = [
  'assets',
  'liabilities',
  'equity',
  'income',
  'cost_of_sales',
  'expense',
];

const isCategory = (v: string | null): v is AccountCategory =>
  v !== null && (CATEGORIES as readonly string[]).includes(v);

/** "TOTAL ASSETS" and "CASH ON HAND" read better as "Total assets": an all-capitals name from a chart is softened. */
export function readable(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, '');
  if (letters.length > 1 && name === name.toUpperCase()) {
    return name.charAt(0) + name.slice(1).toLowerCase();
  }
  return name;
}

/**
 * The posting accounts of the chart in chart order, each with its group. A group is the nearest heading above the account
 * inside its section; an account with no heading falls under its section ("Equity"). The company can change its chart and
 * the statements follow it, because nothing here knows an account number.
 */
export async function loadChart(db: DrizzleDb, companyId: string): Promise<ChartAccount[]> {
  const all = await db.select().from(glAccounts).where(eq(glAccounts.companyId, companyId));
  const sorted = [...all].sort((a, b) => compareAccountNo(a.no, b.no));
  const out: ChartAccount[] = [];
  let section = '';
  let sectionNo = '';
  let heading = '';
  let headingNo = '';
  for (const a of sorted) {
    if (a.type === 'begin_total') {
      section = readable(a.name);
      sectionNo = a.no;
      heading = '';
      headingNo = '';
    } else if (a.type === 'end_total') {
      section = '';
      sectionNo = '';
      heading = '';
      headingNo = '';
    } else if (a.type === 'heading') {
      heading = readable(a.name);
      headingNo = a.no;
    } else if (a.type === 'posting' && isCategory(a.category)) {
      out.push({
        id: a.id,
        no: a.no,
        name: a.name,
        category: a.category,
        normal: a.normalBalance,
        group: firstFilled(heading, section, a.category),
        groupNo: firstFilled(headingNo, sectionNo, a.no),
      });
    }
  }
  return out;
}

/** The accounts that hold the business's cash: every account a payment method posts to, and the cash and bank group. */
export async function cashAccountIds(
  db: DrizzleDb,
  companyId: string,
  chart: readonly ChartAccount[],
): Promise<Set<string>> {
  const methods = await db
    .selectDistinct({ id: paymentMethods.glAccountId })
    .from(paymentMethods)
    .where(eq(paymentMethods.companyId, companyId));
  const ids = new Set(methods.map((m) => m.id));
  for (const a of chart) {
    if (a.category === 'assets' && /^cash( and|$| &)/i.test(a.group)) ids.add(a.id);
  }
  return ids;
}

const toNets = (r: { account_id: string; net: string }[]): Nets =>
  new Map(r.map((x) => [x.account_id, parseAmount(x.net)]));

const branchClause = (branchId: string | null) =>
  branchId === null ? sql`` : sql`and e.branch_id = ${branchId}::uuid`;

/** What each account moved by between two posting dates, both included. Straight from the ledger entries. */
export async function movement(
  db: DrizzleDb,
  companyId: string,
  fromDate: string,
  toDate: string,
  branchId: string | null,
): Promise<Nets> {
  const r = await rows<{ account_id: string; net: string }>(
    db,
    sql`
      select e.account_id::text as account_id, sum(e.base_debit - e.base_credit)::text as net
      from gl_entries e
      where e.company_id = ${companyId}::uuid
        and e.posting_date >= ${fromDate}::date and e.posting_date <= ${toDate}::date
        ${branchClause(branchId)}
      group by e.account_id
    `,
  );
  return toNets(r);
}

/**
 * What each account stood at on a date, counting everything posted up to and including it. For the whole company the closed
 * stretch comes from the running balances (one row per account and period, never a scan of the ledger) and only the days
 * after the last whole period come from the entries; for one branch, which the balances do not split, the entries are read.
 */
export async function balancesAt(
  db: DrizzleDb,
  companyId: string,
  date: string,
  branchId: string | null,
): Promise<Nets> {
  if (branchId !== null) {
    const r = await rows<{ account_id: string; net: string }>(
      db,
      sql`
        select e.account_id::text as account_id, sum(e.base_debit - e.base_credit)::text as net
        from gl_entries e
        where e.company_id = ${companyId}::uuid and e.posting_date <= ${date}::date
          and e.branch_id = ${branchId}::uuid
        group by e.account_id
      `,
    );
    return toNets(r);
  }
  const r = await rows<{ account_id: string; net: string }>(
    db,
    sql`
      with cut as (
        select max(p.ends_on) as d
        from accounting_periods p
        where p.company_id = ${companyId}::uuid and p.ends_on <= ${date}::date
      )
      select account_id, sum(net)::text as net
      from (
        select b.account_id::text as account_id, sum(b.base_debit - b.base_credit) as net
        from gl_account_balances b
        join accounting_periods p on p.id = b.period_id
        where b.company_id = ${companyId}::uuid
          and p.ends_on <= (select d from cut)
        group by b.account_id
        union all
        select e.account_id::text, sum(e.base_debit - e.base_credit)
        from gl_entries e
        where e.company_id = ${companyId}::uuid
          and e.posting_date <= ${date}::date
          and e.posting_date > coalesce((select d from cut), '0001-01-01'::date)
        group by e.account_id
      ) x
      group by account_id
    `,
  );
  return toNets(r);
}

/** The first day of the fiscal year a date falls in, or null when no fiscal year is set up for it. */
export async function fiscalYearStart(
  db: DrizzleDb,
  companyId: string,
  date: string,
): Promise<string | null> {
  const [fy] = await db
    .select({ startsOn: fiscalYears.startsOn, endsOn: fiscalYears.endsOn })
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        sql`${fiscalYears.startsOn} <= ${date}::date`,
        sql`${fiscalYears.endsOn} >= ${date}::date`,
      ),
    )
    .limit(1);
  return fy?.startsOn ?? null;
}

/** A day before a date, as YYYY-MM-DD (the closing day of the stretch before it). */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** The accounts the general posting setup names as sales, sales returns and sales discounts. Empty sets when none is set up. */
export async function salesRoleAccounts(
  db: DrizzleDb,
  companyId: string,
): Promise<{ revenue: Set<string> }> {
  const r = await rows<{ id: string }>(
    db,
    sql`
      select distinct a.id::text as id
      from general_posting_setup s
      cross join lateral (values (s.sales_account_id), (s.sales_returns_account_id), (s.sales_discount_account_id)) as a(id)
      where s.company_id = ${companyId}::uuid and a.id is not null
    `,
  );
  return { revenue: new Set(r.map((x) => x.id)) };
}
