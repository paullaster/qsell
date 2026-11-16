'use server';

import { runSetting } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import { getContainer } from '@/server/di/container';
import type { SmsOutcome } from './accounts';

const PATHS = ['/admin/settings/sms'];
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const CODE_FOR = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', conflict: 'CONFLICT', not_allowed: 'NOT_ALLOWED' } as const;

function dataOf<T>(result: SmsOutcome<T>): T {
  if (result.ok) return result.data;
  throw new SettingsError(result.message, CODE_FOR[result.reason]);
}

const idOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const versionOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

/** The SMS connections of the company, for their screen. Nothing secret is in what comes back. */
export async function smsScreenAction() {
  return await runSetting('sms:manage', async (ctx) => await getContainer().smsAccounts.list(ctx.companyId));
}

export async function createSmsAccountAction(raw: unknown) {
  return await runSetting('sms:manage', async (ctx) => dataOf(await getContainer().smsAccounts.create({ companyId: ctx.companyId, userId: ctx.userId }, obj(raw))), { paths: PATHS });
}

export async function updateSmsAccountAction(raw: unknown) {
  return await runSetting('sms:manage', async (ctx) => {
    const i = obj(raw);
    return dataOf(await getContainer().smsAccounts.update({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id), i));
  }, { paths: PATHS });
}

export async function setSmsAccountActiveAction(raw: unknown) {
  return await runSetting('sms:manage', async (ctx) => {
    const i = obj(raw);
    return dataOf(await getContainer().smsAccounts.setActive({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id), i.isActive === true, versionOf(i.expectedVersion)));
  }, { paths: PATHS });
}

export async function makeSmsAccountDefaultAction(raw: unknown) {
  return await runSetting('sms:manage', async (ctx) => {
    const i = obj(raw);
    return dataOf(await getContainer().smsAccounts.setDefault({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id), versionOf(i.expectedVersion)));
  }, { paths: PATHS });
}

/** Sends the fixed test message to the number typed, through this connection. */
export async function sendTestSmsAction(raw: unknown) {
  return await runSetting('sms:manage', async (ctx) => {
    const i = obj(raw);
    return dataOf(await getContainer().smsAccounts.sendTest({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.id), { to: i.to, shopName: ctx.company.tradingName }));
  }, { paths: PATHS });
}
