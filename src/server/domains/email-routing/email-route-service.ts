import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { emailRoutes, users } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { resolveCompanyUiConfig } from '@/config/company-ui';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import { isDeliverableAddress } from '@/server/adapters/email/sender';
import { EMAIL_POINTS, isEmailPointKey, pointOf, type EmailPointKey } from './email-points';
import { checkRouteInput, idsNeeded, LIST_NAMES, readRouteConfig, readSources, resolveRoute, type ListName, type ResolvedRoute, type RouteConfig, type RouteSource } from './email-routes';

export class EmailRoutingError extends Error {}

/** What is known about the people a mail concerns when it is sent. */
export interface SendContext {
  customerEmail: string | null;
  /** The staff member who pressed the button. */
  actorUserId?: string | null;
  /** The staff member who made the quote. */
  ownerUserId?: string | null;
}

/** A source with the words the screen shows for it and, when it can be found now, the address it points to. */
export interface LabelledSource {
  source: RouteSource;
  label: string;
  /** The address it resolves to now; null for the customer and the staff member doing it (known only when sent) and for one that cannot be found. */
  address: string | null;
  /** Why it cannot be found, when it cannot. */
  problem: string | null;
}

export interface PointView {
  key: EmailPointKey;
  label: string;
  description: string;
  kind: 'mail' | 'document';
  enabled: boolean;
  lists: Record<ListName, LabelledSource[]>;
  version: number;
  /** Changed from the built-in behaviour. */
  configured: boolean;
}

/** A source with the words the screen shows for it and the address it finds now. */
export function labelSource(source: RouteSource, staff: ReadonlyMap<string, { name: string; email: string }>, channels: ReadonlyMap<string, { label: string; address: string }>, companyEmail: string): LabelledSource {
  switch (source.kind) {
    case 'staff': {
      const found = staff.get(source.userId);
      return { source, label: found?.name ?? 'A staff member', address: found?.email ?? null, problem: found === undefined ? 'This staff member has no active account, so nothing will be sent to them.' : null };
    }
    case 'company':
      return { source, label: 'The company email (Company Setup)', address: companyEmail, problem: null };
    case 'channel': {
      const found = channels.get(source.channelId);
      return { source, label: found === undefined ? 'A support channel' : `${found.label} (support channel)`, address: found?.address ?? null, problem: found === undefined ? 'This is not an email channel in Company Setup any more, so nothing will be sent to it.' : null };
    }
    case 'customer':
      return { source, label: 'The customer', address: null, problem: null };
    case 'actor':
      return { source, label: 'The staff member who sends it', address: null, problem: null };
    case 'owner':
      return { source, label: 'The staff member who made the quote', address: null, problem: null };
    case 'address':
      return { source, label: source.address, address: source.address, problem: null };
  }
}

type Why = ReasonInput;

/** Staff accounts that can be written to: a real staff account (not a customer), active and not suspended. */
const staffWhere = (ids: string[]) => and(inArray(users.id, ids), eq(users.status, 'active'), eq(users.isActive, true));

export class EmailRouteService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly company: CompanySettingsRepository,
  ) {}

  private async stored(companyId: string, point: EmailPointKey): Promise<{ config: RouteConfig; version: number; configured: boolean }> {
    const [row] = await this.db.select().from(emailRoutes).where(and(eq(emailRoutes.companyId, companyId), eq(emailRoutes.point, point))).limit(1);
    const defaults = pointOf(point).defaults;
    return row === undefined ? { config: defaults, version: 0, configured: false } : { config: readRouteConfig(row.config, defaults), version: row.version, configured: true };
  }

  /** The company's email channels (Company Setup, Support), by id. */
  private async channels(companyId: string): Promise<Map<string, { label: string; address: string }>> {
    const row = await this.company.ensureSeeded();
    if (row.id !== companyId) return new Map();
    const support = resolveCompanyUiConfig(row.uiConfig).support;
    return new Map(support.channels.filter((c) => c.kind === 'email').map((c) => [c.id, { label: c.label === '' ? c.value : c.label, address: c.value }]));
  }

  private async staff(ids: readonly string[]): Promise<Map<string, { name: string; email: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(staffWhere([...ids]));
    return new Map(rows.map((r) => [r.id, { name: r.name, email: r.email }]));
  }

  /** The addresses a mail goes to now for this point and these people; what the senders use. */
  async resolve(companyId: string, point: EmailPointKey, context: SendContext): Promise<ResolvedRoute> {
    return await this.resolveConfig(companyId, (await this.stored(companyId, point)).config, context);
  }

  /** The staff accounts a point writes to (the To, Cc and Bcc lists only): who a text message or a browser alert for it goes to as well. */
  async staffIds(companyId: string, point: EmailPointKey, context: Pick<SendContext, 'actorUserId' | 'ownerUserId'>): Promise<string[]> {
    const { config } = await this.stored(companyId, point);
    const needed = idsNeeded({ ...config, replyTo: [], shown: [] }, { actorUserId: context.actorUserId ?? null, ownerUserId: context.ownerUserId ?? null });
    return needed.staff;
  }

  private async resolveConfig(companyId: string, config: RouteConfig, context: SendContext): Promise<ResolvedRoute> {
    const actorUserId = context.actorUserId ?? null;
    const ownerUserId = context.ownerUserId ?? null;
    const needed = idsNeeded(config, { actorUserId, ownerUserId });
    const [staff, channels, company] = await Promise.all([this.staff(needed.staff), this.channels(companyId), this.company.ensureSeeded()]);
    return resolveRoute(config, {
      customerEmail: context.customerEmail,
      companyEmail: company.email,
      channelEmails: new Map([...channels].map(([id, c]) => [id, c.address])),
      staffEmails: new Map([...staff].map(([id, s]) => [id, s.email])),
      actorUserId,
      ownerUserId,
    });
  }

  /**
   * The business emails a quote shows to its customer (on the document, the public page and the email): the quote's own list when it
   * has one, else the company's setting for its flow (made by staff, or asked for on the web shop), else the company email.
   */
  async quoteContacts(companyId: string, quote: { source: string; contactEmails: unknown; createdBy: string | null; customerEmail: string | null }): Promise<string[]> {
    const stored = await this.stored(companyId, quote.source === 'shop' ? 'quote_document_shop' : 'quote_document_staff');
    const own = quote.contactEmails;
    const shown = Array.isArray(own) ? readSources(own) : stored.config.shown;
    const ownerUserId = quote.createdBy !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quote.createdBy) ? quote.createdBy : null;
    const found = await this.resolveConfig(companyId, { ...stored.config, shown }, { customerEmail: quote.customerEmail, ownerUserId });
    if (found.shown.length > 0) return found.shown;
    const company = await this.company.ensureSeeded();
    return isDeliverableAddress(company.email) ? [company.email.trim()] : [];
  }

  /** The words and addresses for a list of sources (a quote's own list of business emails, for its editor). */
  async describe(companyId: string, sources: readonly RouteSource[]): Promise<LabelledSource[]> {
    const staffIds = sources.flatMap((s) => (s.kind === 'staff' ? [s.userId] : []));
    const [staff, channels, company] = await Promise.all([this.staff(staffIds), this.channels(companyId), this.company.ensureSeeded()]);
    return sources.map((s) => labelSource(s, staff, channels, company.email));
  }

  /** Every point as the screen shows it: with the words and the address each source finds now. */
  async screen(companyId: string): Promise<PointView[]> {
    const rows = await this.db.select().from(emailRoutes).where(eq(emailRoutes.companyId, companyId));
    const byPoint = new Map(rows.map((r) => [r.point, r]));
    const configs = EMAIL_POINTS.map((p) => {
      const row = byPoint.get(p.key);
      return { point: p, config: row === undefined ? p.defaults : readRouteConfig(row.config, p.defaults), version: row?.version ?? 0, configured: row !== undefined };
    });
    const everyStaff = new Set<string>();
    for (const { config } of configs) for (const name of LIST_NAMES) for (const s of config[name]) if (s.kind === 'staff') everyStaff.add(s.userId);
    const [staff, channels, company] = await Promise.all([this.staff([...everyStaff]), this.channels(companyId), this.company.ensureSeeded()]);
    const label = (source: RouteSource): LabelledSource => labelSource(source, staff, channels, company.email);
    return configs.map(({ point, config, version, configured }) => ({
      key: point.key,
      label: point.label,
      description: point.description,
      kind: point.kind,
      enabled: config.enabled,
      lists: { to: config.to.map(label), cc: config.cc.map(label), bcc: config.bcc.map(label), replyTo: config.replyTo.map(label), shown: config.shown.map(label) },
      version,
      configured,
    }));
  }

  /** Saves one point. The people chosen must exist (an active staff account, an email channel) so a typo or a stale screen cannot save a dead address. */
  async save(companyId: string, pointKey: unknown, raw: unknown, actor: Actor, reason: Why): Promise<void> {
    if (!isEmailPointKey(pointKey)) throw new EmailRoutingError('That email is not one that can be set up.');
    const point = pointOf(pointKey);
    const checked = checkRouteInput(raw, point.kind);
    if (!checked.ok) throw new EmailRoutingError(checked.error);
    const { config } = checked;
    const needed = idsNeeded(config, { actorUserId: null, ownerUserId: null });
    const [staff, channels] = await Promise.all([this.staff(needed.staff), this.channels(companyId)]);
    if (needed.staff.some((id) => !staff.has(id))) throw new EmailRoutingError('A staff member you chose has no active account. Remove them or choose someone else.');
    if (needed.channels.some((id) => !channels.has(id))) throw new EmailRoutingError('A support channel you chose is not an email channel in Company Setup. Remove it or choose another.');
    const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
    const why = await this.reasons.require(companyId, reason, 'email_configuration');
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(emailRoutes).where(and(eq(emailRoutes.companyId, companyId), eq(emailRoutes.point, pointKey))).limit(1).for('update');
      if (before === undefined) await tx.insert(emailRoutes).values({ companyId, point: pointKey, config: given, version: 1, updatedBy: actor.id ?? 'system' });
      else await tx.update(emailRoutes).set({ config: given, version: before.version + 1, updatedBy: actor.id ?? 'system', updatedAt: new Date() }).where(eq(emailRoutes.id, before.id));
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'email_route', id: pointKey },
          action: before === undefined ? 'email_routing.configured' : 'email_routing.changed',
          reason: why,
          inputs: before === undefined ? {} : { version: before.version },
          outcome: { enabled: config.enabled, to: config.to.length, cc: config.cc.length, bcc: config.bcc.length, replyTo: config.replyTo.length, shown: config.shown.length },
        },
        tx,
      );
    });
  }

  /** Puts a point back to the built-in behaviour. */
  async reset(companyId: string, pointKey: unknown, actor: Actor, reason: Why): Promise<void> {
    if (!isEmailPointKey(pointKey)) throw new EmailRoutingError('That email is not one that can be set up.');
    const why = await this.reasons.require(companyId, reason, 'email_configuration');
    await this.db.transaction(async (tx) => {
      const removed = await tx.delete(emailRoutes).where(and(eq(emailRoutes.companyId, companyId), eq(emailRoutes.point, pointKey))).returning({ id: emailRoutes.id });
      if (removed.length === 0) return;
      await this.decisions.record({ companyId, actor, subject: { type: 'email_route', id: pointKey }, action: 'email_routing.reset', reason: why, inputs: {}, outcome: {} }, tx);
    });
  }
}
