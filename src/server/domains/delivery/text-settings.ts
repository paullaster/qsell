import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveryTextSettings } from '@/server/db/drizzle/schema';
import { DEFAULT_REMINDERS, TEXT_KIND_CHOICES, readQuietHours, readReminders, readTextKinds, type CollectionReminders, type MessageKind, type QuietHours } from '@/lib/delivery-messages';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface TextSettingsView {
  enabled: boolean;
  kinds: MessageKind[];
  /** Texts are held for the morning between these times (business time), or sent at any hour when null. */
  quiet: QuietHours | null;
  /** Reminders for an order left at the counter. They go by mail whatever the texting setting is. */
  reminders: CollectionReminders;
  version: number;
}

const DEFAULT_KINDS: MessageKind[] = TEXT_KIND_CHOICES.filter((c) => c.onByDefault).map((c) => c.kind);
const quietOf = (from: number | null, until: number | null): QuietHours | null => (from === null || until === null ? null : { from, until });
const remindersOf = (r: typeof deliveryTextSettings.$inferSelect): CollectionReminders => ({ enabled: r.collectionRemindersOn, firstDays: r.collectionReminderFirstDays, secondDays: r.collectionReminderSecondDays });
const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });

/**
 * Whether customers are also texted about their delivery, and which messages. Off until the company turns it on, because every text costs
 * money at the company's own SMS provider. Changes use a version and go to the decision log.
 */
export class DeliveryTextSettings {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async get(companyId: string, tx: Pick<Tx, 'select'> | DrizzleDb = this.db): Promise<TextSettingsView> {
    const [row] = await tx.select().from(deliveryTextSettings).where(eq(deliveryTextSettings.companyId, companyId));
    if (row === undefined) return { enabled: false, kinds: DEFAULT_KINDS, quiet: null, reminders: DEFAULT_REMINDERS, version: 1 };
    const checked = readTextKinds(row.kinds);
    return { enabled: row.enabled, kinds: checked.ok ? checked.kinds : DEFAULT_KINDS, quiet: quietOf(row.quietFromMinute, row.quietUntilMinute), reminders: remindersOf(row), version: row.version };
  }

  async set(actor: DocActor, input: { enabled: unknown; kinds: unknown; quietFrom?: unknown; quietUntil?: unknown; expectedVersion: unknown }): Promise<DocResult<TextSettingsView>> {
    const kinds = readTextKinds(input.kinds);
    if (!kinds.ok) return fail('bad_input', kinds.error);
    const quiet = readQuietHours(input.quietFrom, input.quietUntil);
    if (!quiet.ok) return fail('bad_input', quiet.error);
    const enabled = input.enabled === true;
    if (enabled && kinds.kinds.length === 0) return fail('bad_input', 'Choose at least one message to text, or turn texting off.');
    return await this.db.transaction(async (tx): Promise<DocResult<TextSettingsView>> => {
      await tx.insert(deliveryTextSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryTextSettings).where(eq(deliveryTextSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) throw new Error('The settings could not be read.');
      if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed these settings. Reload to see the latest.');
      const [saved] = await tx.update(deliveryTextSettings).set({ enabled, kinds: kinds.kinds, quietFromMinute: quiet.quiet?.from ?? null, quietUntilMinute: quiet.quiet?.until ?? null, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryTextSettings.companyId, actor.companyId)).returning();
      if (saved === undefined) throw new Error('The settings were not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_text_settings', id: actor.companyId }, action: 'delivery.text_settings_changed', actor: { type: 'user', id: actor.userId }, inputs: { before: { enabled: row.enabled, kinds: row.kinds, quiet: quietOf(row.quietFromMinute, row.quietUntilMinute) }, after: { enabled, kinds: kinds.kinds, quiet: quiet.quiet } } }, tx);
      return { ok: true, data: { enabled: saved.enabled, kinds: kinds.kinds, quiet: quiet.quiet, reminders: remindersOf(saved), version: saved.version } };
    });
  }

  /** Reminders for an order left at the counter: whether, and after how many days. Its own save, with the same version as the texts so two people cannot overwrite each other. */
  async setReminders(actor: DocActor, input: { enabled: unknown; firstDays: unknown; secondDays?: unknown; expectedVersion: unknown }): Promise<DocResult<TextSettingsView>> {
    const read = readReminders(input.enabled, input.firstDays, input.secondDays);
    if (!read.ok) return fail('bad_input', read.error);
    const next = read.reminders;
    return await this.db.transaction(async (tx): Promise<DocResult<TextSettingsView>> => {
      await tx.insert(deliveryTextSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryTextSettings).where(eq(deliveryTextSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) throw new Error('The settings could not be read.');
      if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed these settings. Reload to see the latest.');
      const [saved] = await tx.update(deliveryTextSettings).set({ collectionRemindersOn: next.enabled, collectionReminderFirstDays: next.firstDays, collectionReminderSecondDays: next.secondDays, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryTextSettings.companyId, actor.companyId)).returning();
      if (saved === undefined) throw new Error('The settings were not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_text_settings', id: actor.companyId }, action: 'delivery.collection_reminders_changed', actor: { type: 'user', id: actor.userId }, inputs: { before: remindersOf(row), after: next } }, tx);
      const checked = readTextKinds(saved.kinds);
      return { ok: true, data: { enabled: saved.enabled, kinds: checked.ok ? checked.kinds : DEFAULT_KINDS, quiet: quietOf(saved.quietFromMinute, saved.quietUntilMinute), reminders: remindersOf(saved), version: saved.version } };
    });
  }
}
