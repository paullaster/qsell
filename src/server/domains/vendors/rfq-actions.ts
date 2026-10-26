'use server';

import { drizzleDb } from '@/server/db/drizzle/client';
import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { emptyRfqHeader, emptyRfqLine, type RfqHeaderForm, type RfqLineForm } from '@/lib/rfq';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const bool = (value: unknown, otherwise: boolean): boolean => (typeof value === 'boolean' ? value : otherwise);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const headerOf = (raw: unknown): RfqHeaderForm => {
  const f = obj(raw);
  const base = emptyRfqHeader();
  return {
    title: str(f.title, 300),
    categoryId: str(f.categoryId, 40) === '' ? '' : id(f.categoryId),
    description: str(f.description, 4000),
    terms: str(f.terms, 4000),
    requiredBy: str(f.requiredBy, 12),
    deadline: str(f.deadline, 20),
    validityDays: str(f.validityDays, 5),
    currency: str(f.currency, 5),
    sealed: bool(f.sealed, base.sealed),
    allowPartial: bool(f.allowPartial, false),
    allowAlternatives: bool(f.allowAlternatives, false),
    estimatedValue: str(f.estimatedValue, 20),
  };
};

const linesOf = (raw: unknown): RfqLineForm[] =>
  (Array.isArray(raw) ? raw.slice(0, 200) : []).map((x) => {
    const l = obj(x);
    const base = emptyRfqLine();
    return { productId: str(l.productId, 80), description: str(l.description, 400), specification: str(l.specification, 2000), quantity: str(l.quantity, 20), unit: str(l.unit, 30) === '' ? base.unit : str(l.unit, 30), requiredDate: str(l.requiredDate, 12) };
  });

export async function rfqListAction(filter: { status?: string; before?: { createdAt: string; id: string } | null } = {}) {
  return await run('rfq:read', { surface: 'rfq/list', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.createdAt.length <= 40 ? filter.before : null;
    const page = await getContainer().rfqs.list(ctx.companyId, { status: has(filter.status) ? str(filter.status, 20) : undefined, before });
    return {
      rows: page.rows.map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, categoryName: r.categoryName, deadline: r.deadline.toISOString(), invited: r.invited, createdAt: r.createdAt.toISOString() })),
      next: page.next,
      can: { create: await canPermission('rfq:create') },
    };
  });
}

/** The request for editing: the header and lines as the form wants them, and who is invited. */
export async function rfqAction(rfqId: string) {
  return await run('rfq:read', { surface: 'rfq/view', action: 'view' }, async (ctx) => {
    const container = getContainer();
    await container.rfqEvaluation.ensureReasons(ctx.companyId);
    const got = await container.rfqs.get(ctx.companyId, id(rfqId));
    if (got === null) throw new FinanceError('NOT_FOUND', 'That request does not exist.');
    const [create, issue, close, evaluate, award] = await Promise.all([canPermission('rfq:create'), canPermission('rfq:issue'), canPermission('rfq:close'), canPermission('rfq:evaluate'), canPermission('rfq:award')]);
    const r = got.rfq;
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = r.deadline;
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      categoryName: got.categoryName,
      deadlineIso: d.toISOString(),
      opensAt: r.opensAt?.toISOString() ?? null,
      closeReason: r.closeReason,
      cancelReason: r.cancelReason,
      awardNote: r.awardNote,
      form: {
        title: r.title,
        categoryId: r.categoryId,
        description: r.description ?? '',
        terms: r.terms ?? '',
        requiredBy: r.requiredBy ?? '',
        deadline: `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
        validityDays: String(r.validityDays),
        currency: r.currency,
        sealed: r.sealed,
        allowPartial: r.allowPartial,
        allowAlternatives: r.allowAlternatives,
        estimatedValue: r.estimatedValue ?? '',
      } satisfies RfqHeaderForm,
      category: { id: r.categoryId, label: got.categoryName },
      lines: got.lines.map((l) => ({ id: l.id, productId: l.productId ?? '', description: l.description, specification: l.specification ?? '', quantity: l.quantity, unit: l.unit, requiredDate: l.requiredDate ?? '' })),
      invitations: got.invitations.map((x) => ({ vendorId: x.i.vendorId, name: x.name, number: x.number, status: x.i.status, declineReason: x.i.declineReason, decision: x.i.decision })),
      addenda: got.addenda.map((a) => ({ number: a.number, body: a.body, at: a.createdAt.toISOString() })),
      questions: got.questions.map((x) => ({ id: x.q.id, vendor: x.name, body: x.q.body, answer: x.q.answer, published: x.q.published, at: x.q.createdAt.toISOString() })),
      events: got.events.map((e) => ({ id: String(e.id), event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), actor: e.actorType })),
      can: { create, issue, close, evaluate, award },
    };
  });
}

export async function saveRfqAction(rfqId: string | null, header: unknown, lines: unknown) {
  return await run('rfq:create', { surface: 'rfq/edit', action: rfqId === null ? 'create' : 'update' }, async (ctx) => {
    return await getContainer().rfqs.saveDraft(ctx, rfqId === null ? null : id(rfqId), headerOf(header), linesOf(lines));
  }, ['/admin/vendors/rfqs']);
}

export async function setRfqInviteesAction(rfqId: string, vendorIds: unknown) {
  return await run('rfq:create', { surface: 'rfq/edit', action: 'invite' }, async (ctx) => {
    const list = Array.isArray(vendorIds) ? vendorIds.slice(0, 60).map(id) : [];
    await getContainer().rfqs.setInvitees(ctx, id(rfqId), list, businessDate());
  });
}

/** The vendors that may be invited to this request: qualified in its category or one inside it. */
export async function eligibleVendorsAction(rfqId: string) {
  return await run('rfq:create', { surface: 'rfq/edit', action: 'eligible' }, async (ctx) => {
    const container = getContainer();
    const got = await container.rfqs.get(ctx.companyId, id(rfqId));
    if (got === null) throw new FinanceError('NOT_FOUND', 'That request does not exist.');
    const ids = await container.prequalLifecycle.qualifiedVendorIds(ctx.companyId, got.rfq.categoryId, businessDate());
    if (ids.length === 0) return [];
    const list = await container.vendors.list(ctx.companyId, { limit: 100 });
    return list.rows.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, name: v.legalName, number: v.number }));
  });
}

export async function issueRfqAction(rfqId: string) {
  return await run('rfq:issue', { surface: 'rfq/edit', action: 'issue' }, async (ctx) => await getContainer().rfqs.issue(ctx, id(rfqId)), ['/admin/vendors/rfqs']);
}

export async function closeRfqEarlyAction(rfqId: string, reason: string) {
  return await run('rfq:close', { surface: 'rfq/edit', action: 'close_early' }, async (ctx) => {
    await getContainer().rfqs.closeEarly(ctx, id(rfqId), str(reason));
  }, ['/admin/vendors/rfqs']);
}

export async function extendRfqAction(rfqId: string, deadline: string, reason: string) {
  return await run('rfq:close', { surface: 'rfq/edit', action: 'extend' }, async (ctx) => {
    await getContainer().rfqs.extend(ctx, id(rfqId), str(deadline, 20), str(reason));
  }, ['/admin/vendors/rfqs']);
}

export async function cancelRfqAction(rfqId: string, reason: string) {
  return await run('rfq:close', { surface: 'rfq/edit', action: 'cancel' }, async (ctx) => {
    await getContainer().rfqs.cancel(ctx, id(rfqId), str(reason));
  }, ['/admin/vendors/rfqs']);
}

export async function rfqAddendumAction(rfqId: string, body: string, newDeadline: string) {
  return await run('rfq:create', { surface: 'rfq/edit', action: 'addendum' }, async (ctx) => await getContainer().rfqs.addendum(ctx, id(rfqId), str(body, 2000), str(newDeadline, 20)));
}

export async function answerRfqQuestionAction(questionId: string, answer: string, publish: boolean) {
  return await run('rfq:create', { surface: 'rfq/edit', action: 'answer' }, async (ctx) => {
    await getContainer().rfqs.answer(ctx, id(questionId), str(answer, 2000), publish);
  });
}

// ── Quotes: compare, decide, award ────────────────────────────────────────────────────────────

export async function rfqQuotesAction(rfqId: string) {
  return await run('rfq:evaluate', { surface: 'rfq/quotes', action: 'view' }, async (ctx) => {
    const container = getContainer();
    await container.rfqEvaluation.ensureReasons(ctx.companyId);
    const [q, awards, award] = await Promise.all([container.rfqEvaluation.quotes(ctx.companyId, id(rfqId)), container.rfqEvaluation.awards(ctx.companyId, id(rfqId)), canPermission('rfq:award')]);
    const awardWaiting = await container.rfqEvaluation.awardWaiting(drizzleDb, id(rfqId));
    return { ...q, awards, awardWaiting, canAward: award && !awardWaiting };
  });
}

export async function decideQuoteAction(rfqId: string, vendorId: string, action: string, input: unknown) {
  return await run('rfq:evaluate', { surface: 'rfq/quotes', action: `decide_${str(action, 10)}` }, async (ctx) => {
    if (action !== 'accept' && action !== 'reject' && action !== 'revise') throw new FinanceError('INVALID', 'Choose accept, refuse or ask for a revision.');
    const i = obj(input);
    await getContainer().rfqEvaluation.decide(ctx, id(rfqId), id(vendorId), action, { reasonCode: str(i.reasonCode, 60), text: str(i.text, 1000), due: str(i.due, 20) });
  });
}

export async function awardRfqAction(rfqId: string, allocations: unknown, justification: string) {
  return await run('rfq:award', { surface: 'rfq/quotes', action: 'award' }, async (ctx) => {
    const list = (Array.isArray(allocations) ? allocations.slice(0, 400) : []).map((x) => {
      const a = obj(x);
      return { rfqLineId: id(a.rfqLineId), vendorId: id(a.vendorId), quantity: str(a.quantity, 20) };
    });
    return await getContainer().rfqEvaluation.award(ctx, id(rfqId), list, str(justification, 1000));
  }, ['/admin/vendors/rfqs']);
}
