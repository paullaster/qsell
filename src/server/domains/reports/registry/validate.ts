import { EN } from '@/lib/reports/messages/en';
import { isPermissionKey } from '@/server/domains/access-control/permissions';
import { isDimensionCode } from '../catalogue/dimensions';
import { measure } from '../catalogue/measures';
import type { ReportDefinition } from './definition';
import { isFamilyCode } from './families';

const CODE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KEYWORD = /^[a-z0-9][a-z0-9 '&/-]*$/;
const FORMATS = ['csv', 'xlsx', 'pdf'] as const;

/**
 * Everything that makes a registry entry complete, as a list of plain sentences (empty when it is fine). Pure, so the
 * registry test can also feed it deliberately broken entries and prove each rule bites.
 */
export function problemsWith(def: ReportDefinition): string[] {
  const out: string[] = [];
  const say = (text: string) => out.push(`${def.code}: ${text}`);

  if (!CODE.test(def.code)) say('the code must be lower-case words joined by hyphens');
  if (!(def.titleId in EN)) say(`the title id ${def.titleId} is not in the message catalogue`);
  if (!(def.questionId in EN))
    say(`the question id ${def.questionId} is not in the message catalogue`);
  if (!isFamilyCode(def.family)) say(`the family ${String(def.family)} does not exist`);

  if (def.permissions.length === 0)
    say('it needs at least one permission, so it is never open to everyone');
  for (const key of def.permissions) {
    if (!isPermissionKey(key)) say(`the permission ${String(key)} does not exist`);
  }
  if (def.costGatedBy !== undefined && !isPermissionKey(def.costGatedBy)) {
    say(`the cost permission ${String(def.costGatedBy)} does not exist`);
  }

  if (def.catalogue === 'complete' && def.measures.length === 0) {
    say('a catalogued report must list its measures');
  }
  if (def.catalogue === 'pending' && def.view !== 'legacy') {
    say('only a legacy report may have measures still to catalogue');
  }
  if (def.catalogue === 'pending' && def.measures.length > 0) {
    say('a report with catalogued measures must be marked complete');
  }

  const known = def.measures.map((code) => ({ code, def: measure(code) }));
  for (const m of known)
    if (m.def === undefined) say(`the measure ${m.code} is not in the catalogue`);
  if (new Set(def.measures).size !== def.measures.length) say('a measure is listed twice');

  for (const d of def.dimensions) {
    if (!isDimensionCode(d)) {
      say(`the dimension ${String(d)} does not exist`);
      continue;
    }
    if (def.measures.length > 0 && !known.some((m) => m.def?.dimensions.includes(d) === true)) {
      say(`no measure of this report can be cut by ${d}`);
    }
  }

  // Cost cannot leak through the registry: a report that carries a cost measure either needs the cost permission
  // to open, or says which permission unlocks the cost figures and withholds them from everyone else.
  const revealsCost = known.some((m) => m.def?.sensitivity === 'cost');
  if (revealsCost) {
    const gated =
      def.permissions.includes('report_profit:read') || def.costGatedBy === 'report_profit:read';
    if (!gated) say('it carries cost measures but is not gated by report_profit:read');
    if (def.sensitivity === 'normal')
      say('it carries cost measures, so its sensitivity cannot be normal');
  }

  if (def.tieOut.kind === 'none' && def.tieOut.reason.trim().length < 20) {
    say('a report with no tie-out must say why, in a full sentence');
  }
  if (def.tieOut.kind !== 'none' && def.tieOut.control.trim() === '') {
    say('a tie-out must name the control it ties to');
  }

  for (const f of def.exportFormats)
    if (!FORMATS.includes(f)) say(`the export format ${f} is not supported`);
  if (new Set(def.exportFormats).size !== def.exportFormats.length)
    say('an export format is listed twice');

  if (!Number.isInteger(def.maxRows) || def.maxRows < 1 || def.maxRows > 100_000) {
    say('maxRows must be a whole number from 1 to 100,000');
  }
  if (!Number.isInteger(def.timeoutMs) || def.timeoutMs < 1_000 || def.timeoutMs > 120_000) {
    say('timeoutMs must be from 1,000 to 120,000');
  }

  if (def.keywords.length < 2) say('it needs at least two search keywords');
  if (new Set(def.keywords).size !== def.keywords.length) say('a keyword is repeated');
  for (const k of def.keywords)
    if (!KEYWORD.test(k)) say(`the keyword "${k}" must be lower case words`);

  if (def.docs.file.trim() === '' || def.docs.heading.trim() === '')
    say('it must point to its documentation');

  if (
    (def.view === 'overview' || def.view === 'legacy') &&
    !(def.href?.startsWith('/admin') ?? false)
  ) {
    say('an overview or legacy report must give its own address under /admin');
  }
  if (def.view === 'table' && def.href !== undefined)
    say('a table report is drawn by the runner and has no address of its own');

  return out;
}
