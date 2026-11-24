import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { ADMIN_NAV } from '@/config/admin-nav/nav.config';
import type { AdminNavItem } from '@/config/admin-nav/types';
import type { ReportDefinition } from './definition';
import {
  FAMILY_CODES,
  FAMILY_LABELS,
  REPORTS,
  findReport,
  groupByFamily,
  visibleReports,
} from './index';
import { problemsWith } from './validate';
import { EN } from '@/lib/reports/messages/en';

const GUIDE_DIR = path.resolve(__dirname, '../../../../../docs/implementor-guide');
const APP_ADMIN_DIR = path.resolve(__dirname, '../../../../../app/admin');

function flattenNav(items: readonly AdminNavItem[]): AdminNavItem[] {
  return items.flatMap((i) => [i, ...flattenNav(i.subLinks ?? [])]);
}

/** A complete entry to break one rule at a time. */
const GOOD: ReportDefinition = {
  code: 'sample-report',
  titleId: 'report.business_overview.title',
  questionId: 'report.business_overview.question',
  family: 'sales',
  permissions: ['report_sales:read'],
  measures: ['sales.total', 'sales.orders'],
  dimensions: ['date', 'branch'],
  tier: 'live',
  scope: 'both',
  tieOut: { kind: 'none', reason: 'Reads orders directly; ties to the books once rollups exist.' },
  sensitivity: 'normal',
  exportFormats: ['csv'],
  maxRows: 1000,
  timeoutMs: 10_000,
  keywords: ['sales', 'sample'],
  docs: {
    file: '01-business-overview-and-dashboard.md',
    heading: 'Section C: Sales Performance & Order Flow',
  },
  view: 'table',
  catalogue: 'complete',
};

const broken = (change: Partial<ReportDefinition>): string[] =>
  problemsWith({ ...GOOD, ...change });

describe('the registry', () => {
  it('has complete entries only', () => {
    for (const def of REPORTS) expect(problemsWith(def), def.code).toEqual([]);
  });

  it('has unique codes and an address only where a screen of its own exists', () => {
    const codes = REPORTS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('points every report at a heading that exists in its implementor guide', () => {
    for (const def of REPORTS) {
      const file = path.join(GUIDE_DIR, def.docs.file);
      expect(existsSync(file), `${def.code}: ${def.docs.file} is missing`).toBe(true);
      const headings = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('#'))
        .map((l) => l.replace(/^#+\s*/, '').trim());
      expect(
        headings.some((h) => h.includes(def.docs.heading)),
        `${def.code}: no heading containing "${def.docs.heading}" in ${def.docs.file}`,
      ).toBe(true);
    }
  });

  it('gives every screen-backed report an address that is a real page', () => {
    for (const def of REPORTS) {
      if (def.href === undefined) continue;
      const relative = def.href === '/admin' ? '' : def.href.replace(/^\/admin\//, '');
      const page = path.join(APP_ADMIN_DIR, relative, 'page.tsx');
      expect(existsSync(page), `${def.code}: ${def.href} has no page at ${page}`).toBe(true);
    }
  });

  it('never asks for less than the screen does: a navigation permission for the address is always required', () => {
    const items = flattenNav(ADMIN_NAV);
    for (const def of REPORTS) {
      if (def.href === undefined) continue;
      const nav = items.filter((i) => i.href === def.href && i.permission !== undefined);
      expect(
        nav.length,
        `${def.code}: ${def.href} is not in the navigation with a permission`,
      ).toBeGreaterThan(0);
      const ok = nav.some((i) =>
        ([] as PermissionKey[]).concat(i.permission ?? []).some((p) => def.permissions.includes(p)),
      );
      expect(ok, `${def.code}: none of the screen's permissions is required by the registry`).toBe(
        true,
      );
    }
  });

  it('lists the reports whose figures are not catalogued yet, so the debt stays visible', () => {
    const pending = REPORTS.filter((r) => r.catalogue === 'pending').map((r) => r.code);
    // Only screens that already exist may wait to be catalogued, and the list must reach zero as they are rebuilt.
    for (const code of pending) expect(findReport(code)?.view, code).toBe('legacy');
    expect(pending.length).toBeLessThanOrEqual(25);
    expect(pending).toContain('customer-analytics');
    expect(pending).not.toContain('business-overview');
    expect(pending).not.toContain('receivables-ageing');
    expect(pending).not.toContain('payables-ageing');
  });

  it('keeps a title and a question for every family and report', () => {
    for (const code of FAMILY_CODES) expect(EN[FAMILY_LABELS[code]], code).toBeTruthy();
    for (const def of REPORTS) {
      expect(EN[def.titleId], def.code).toBeTruthy();
      expect(EN[def.questionId], def.code).toBeTruthy();
    }
  });

  it('finds a report by code and by nothing else', () => {
    expect(findReport('business-overview')?.href).toBe('/admin');
    expect(findReport('nope')).toBeUndefined();
    expect(findReport('')).toBeUndefined();
  });

  it('shows a person only the reports whose every permission they hold', () => {
    expect(visibleReports(new Set<PermissionKey>()).map((r) => r.code)).toEqual([]);
    expect(visibleReports(new Set<PermissionKey>(['dashboard:read'])).map((r) => r.code)).toEqual([
      'business-overview',
    ]);
    // Sales permission alone opens the sales reports and nothing that needs more (the margin report also needs cost rights).
    const sales = visibleReports(new Set<PermissionKey>(['report_sales:read'])).map((r) => r.code);
    expect(sales).toContain('sales-by-product');
    expect(sales).not.toContain('gross-margin');
    expect(sales).not.toContain('business-overview');
    const withCost = visibleReports(
      new Set<PermissionKey>(['report_sales:read', 'report_profit:read']),
    ).map((r) => r.code);
    expect(withCost).toContain('gross-margin');
  });

  it('groups by family in the hub order and leaves empty families out', () => {
    const groups = groupByFamily(REPORTS);
    const order = groups.map((g) => FAMILY_CODES.indexOf(g.family));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(groups[0]?.family).toBe('executive');
    expect(new Set(groups.map((g) => g.family)).size).toBe(groups.length);
    for (const g of groups) expect(g.reports.length).toBeGreaterThan(0);
    expect(groupByFamily([])).toEqual([]);
  });
});

describe('what the registry refuses', () => {
  it('accepts the sample entry', () => {
    expect(problemsWith(GOOD)).toEqual([]);
  });

  it('refuses a report open to everyone', () => {
    expect(broken({ permissions: [] }).join()).toMatch(/at least one permission/);
  });

  it('refuses a permission that does not exist', () => {
    expect(broken({ permissions: ['nope:read' as PermissionKey] }).join()).toMatch(
      /does not exist/,
    );
  });

  it('refuses a measure that is not in the catalogue and an empty catalogued list', () => {
    expect(broken({ measures: ['sales.nothing'] }).join()).toMatch(/not in the catalogue/);
    expect(broken({ measures: [] }).join()).toMatch(/must list its measures/);
    expect(broken({ measures: ['sales.total', 'sales.total'] }).join()).toMatch(/listed twice/);
  });

  it('refuses a cut no measure of the report supports', () => {
    expect(
      broken({ measures: ['inventory.out_of_stock'], dimensions: ['salesperson'] }).join(),
    ).toMatch(/no measure of this report can be cut by salesperson/);
  });

  it('refuses a cost measure that is not gated by the cost permission', () => {
    const text = broken({ measures: ['profit.gross'], sensitivity: 'cost' }).join();
    expect(text).toMatch(/not gated by report_profit:read/);
  });

  it('lets a cost measure through when the cost permission is required or unlocks it', () => {
    expect(
      broken({
        measures: ['profit.gross'],
        sensitivity: 'cost',
        permissions: ['report_profit:read'],
      }),
    ).toEqual([]);
    expect(
      broken({
        measures: ['profit.gross'],
        sensitivity: 'cost',
        costGatedBy: 'report_profit:read',
      }),
    ).toEqual([]);
  });

  it('refuses a cost report that calls itself normal', () => {
    expect(
      broken({
        measures: ['profit.gross'],
        permissions: ['report_profit:read'],
        sensitivity: 'normal',
      }).join(),
    ).toMatch(/sensitivity cannot be normal/);
  });

  it('refuses a missing or empty tie-out explanation', () => {
    expect(broken({ tieOut: { kind: 'none', reason: 'n/a' } }).join()).toMatch(/must say why/);
    expect(broken({ tieOut: { kind: 'gl', control: ' ' } }).join()).toMatch(/name the control/);
    expect(broken({ tieOut: { kind: 'gl', control: 'Trade debtors control' } })).toEqual([]);
  });

  it('refuses silly limits and keywords', () => {
    expect(broken({ maxRows: 0 }).join()).toMatch(/maxRows/);
    expect(broken({ maxRows: 1_000_000 }).join()).toMatch(/maxRows/);
    expect(broken({ timeoutMs: 10 }).join()).toMatch(/timeoutMs/);
    expect(broken({ keywords: ['one'] }).join()).toMatch(/two search keywords/);
    expect(broken({ keywords: ['a b', 'Bad Case'] }).join()).toMatch(/lower case/);
    expect(broken({ keywords: ['same', 'same'] }).join()).toMatch(/repeated/);
  });

  it('refuses a bad code and an address where none belongs', () => {
    expect(broken({ code: 'Bad Code' }).join()).toMatch(/lower-case words/);
    expect(broken({ href: '/admin/x' }).join()).toMatch(/has no address of its own/);
    expect(broken({ view: 'legacy' }).join()).toMatch(/must give its own address/);
    expect(broken({ view: 'legacy', href: 'https://elsewhere.example' }).join()).toMatch(
      /own address under \/admin/,
    );
  });

  it('allows an uncatalogued report only for a legacy screen', () => {
    expect(
      broken({
        view: 'legacy',
        href: '/admin/finance/ageing',
        measures: [],
        dimensions: [],
        catalogue: 'pending',
      }),
    ).toEqual([]);
    expect(
      broken({ view: 'table', measures: [], dimensions: [], catalogue: 'pending' }).join(),
    ).toMatch(/only a legacy report/);
    expect(broken({ view: 'legacy', href: '/admin/x', catalogue: 'pending' }).join()).toMatch(
      /must be marked complete/,
    );
  });

  it('refuses a message id that has no words', () => {
    expect(broken({ titleId: 'report.nothing' as never }).join()).toMatch(
      /not in the message catalogue/,
    );
  });
});
