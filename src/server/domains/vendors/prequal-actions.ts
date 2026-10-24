'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { emptyCategory, emptyQuestion, QUESTION_KINDS, type CategoryForm, type QuestionForm } from '@/lib/prequalification';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const bool = (value: unknown, otherwise: boolean): boolean => (typeof value === 'boolean' ? value : otherwise);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const reasonOf = (r: unknown): { code: string; text: string } => {
  const raw = obj(r);
  return { code: str(raw.code, 60), text: str(raw.text) };
};

// ── Categories (designer) ─────────────────────────────────────────────────────────────────────

export async function categoriesAction() {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: 'list' }, async (ctx) => {
    const rows = await getContainer().categories.list(ctx.companyId);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status, parent: r.parentId === null ? null : (names.get(r.parentId) ?? null), validityMonths: r.validityMonths, qualified: r.qualified }));
  });
}

export async function categoryAction(categoryId: string) {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const got = await container.categories.get(ctx.companyId, id(categoryId));
    if (got === null) throw new FinanceError('NOT_FOUND', 'That category does not exist.');
    const types = await container.vendorProfile.documentTypes(ctx.companyId);
    const c = got.category;
    const parent = c.parentId === null ? null : await container.categories.get(ctx.companyId, c.parentId);
    return {
      id: c.id,
      code: c.code,
      status: c.status,
      locked: c.status !== 'draft',
      form: {
        code: c.code,
        name: c.name,
        description: c.description ?? '',
        parentId: c.parentId ?? '',
        validityMonths: String(c.validityMonths),
        windowFrom: c.windowFrom ?? '',
        windowTo: c.windowTo ?? '',
        passMarkPercent: c.passMarkPercent === null ? '' : String(Number(c.passMarkPercent)),
        fourEyes: c.fourEyes,
        showTotalScore: c.showTotalScore,
        showPassMark: c.showPassMark,
        showQuestionScores: c.showQuestionScores,
        showEvaluatorComments: c.showEvaluatorComments,
      } satisfies CategoryForm,
      parent: parent === null ? null : { id: parent.category.id, label: parent.category.name },
      questions: got.questions.map((q) => ({ id: q.id, prompt: q.prompt, kind: q.kind, choices: q.choices, weight: q.weight, required: q.required })),
      documentTypeIds: got.documents.map((d) => d.documentTypeId),
      documentTypes: types.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name })),
    };
  });
}

const formOf = (raw: unknown): CategoryForm => {
  const f = obj(raw);
  const base = emptyCategory();
  return {
    code: str(f.code, 40),
    name: str(f.name, 200),
    description: str(f.description, 1000),
    parentId: str(f.parentId, 40) === '' ? '' : id(f.parentId),
    validityMonths: str(f.validityMonths, 5),
    windowFrom: str(f.windowFrom, 12),
    windowTo: str(f.windowTo, 12),
    passMarkPercent: str(f.passMarkPercent, 8),
    fourEyes: bool(f.fourEyes, base.fourEyes),
    showTotalScore: bool(f.showTotalScore, false),
    showPassMark: bool(f.showPassMark, false),
    showQuestionScores: bool(f.showQuestionScores, false),
    showEvaluatorComments: bool(f.showEvaluatorComments, false),
  };
};

export async function saveCategoryAction(categoryId: string | null, form: unknown) {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: categoryId === null ? 'create' : 'update' }, async (ctx) => {
    return await getContainer().categories.save(ctx.companyId, categoryId === null ? null : id(categoryId), formOf(form));
  }, ['/admin/vendors/categories']);
}

export async function addQuestionAction(categoryId: string, form: unknown) {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: 'add_question' }, async (ctx) => {
    const f = obj(form);
    const kind = QUESTION_KINDS.find((k) => k.id === f.kind)?.id ?? emptyQuestion().kind;
    const q: QuestionForm = { prompt: str(f.prompt, 400), kind, choices: str(f.choices, 2000), weight: str(f.weight, 5), required: bool(f.required, true) };
    return await getContainer().categories.addQuestion(ctx.companyId, id(categoryId), q);
  });
}

export async function removeQuestionAction(categoryId: string, questionId: string) {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: 'remove_question' }, async (ctx) => {
    await getContainer().categories.removeQuestion(ctx.companyId, id(categoryId), id(questionId));
  });
}

export async function setCategoryDocumentsAction(categoryId: string, documentTypeIds: unknown) {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: 'set_documents' }, async (ctx) => {
    const ids = Array.isArray(documentTypeIds) ? documentTypeIds.slice(0, 30).map(id) : [];
    await getContainer().categories.setDocuments(ctx.companyId, id(categoryId), ids);
  });
}

export async function setCategoryStatusAction(categoryId: string, to: string) {
  return await run('prequalification:manage', { surface: 'prequalification/categories', action: `status_${str(to, 12)}` }, async (ctx) => {
    if (to !== 'open' && to !== 'closed' && to !== 'archived') throw new FinanceError('INVALID', 'Choose open, close or archive.');
    await getContainer().categories.setStatus(ctx.companyId, id(categoryId), to);
  }, ['/admin/vendors/categories']);
}

// ── Applications (staff) ──────────────────────────────────────────────────────────────────────

export async function prequalQueueAction(filter: { status?: string; categoryId?: string; before?: { createdAt: string; id: string } | null } = {}) {
  return await run('vendors:read', { surface: 'prequalification/queue', action: 'list' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.createdAt.length <= 40 ? filter.before : null;
    return await getContainer().prequalReview.list(ctx.companyId, { status: has(filter.status) ? str(filter.status, 30) : undefined, categoryId: has(filter.categoryId) && UUID.test(filter.categoryId) ? filter.categoryId : undefined, before });
  });
}

export async function prequalDetailAction(entryId: string) {
  return await run('vendors:read', { surface: 'prequalification/entry', action: 'view' }, async (ctx) => {
    const container = getContainer();
    await container.prequalReview.ensureReasons(ctx.companyId);
    const d = await container.prequalReview.detail(ctx.companyId, id(entryId));
    if (d === null) throw new FinanceError('NOT_FOUND', 'That application does not exist.');
    const [evaluate, decide] = await Promise.all([canPermission('prequalification:evaluate'), canPermission('prequalification:decide')]);
    const e = d.entry;
    const mine = d.evaluators.some((x) => x.userId === ctx.actor.id);
    return {
      id: e.id,
      status: e.status,
      vendorId: e.vendorId,
      vendorName: d.vendorName,
      vendorNumber: d.vendorNumber,
      categoryName: d.category.name,
      fourEyes: d.category.fourEyes,
      submittedAt: e.submittedAt?.toISOString() ?? null,
      validFrom: e.validFrom,
      validUntil: e.validUntil,
      maxOrderValue: e.maxOrderValue,
      conditionsNote: e.conditionsNote,
      reasonCode: e.reasonCode,
      decisionComment: e.decisionComment,
      suspendedBecause: e.suspendedBecause,
      questions: d.questions.map((q) => ({ id: q.id, prompt: q.prompt, kind: q.kind, weight: q.weight, required: q.required, answer: q.answer, scores: q.scores.map((s) => ({ evaluator: s.evaluator, score: s.score, comment: s.comment, mine: s.evaluatorId === ctx.actor.id })) })),
      documents: d.documents,
      evaluators: d.evaluators.map((x) => x.name),
      totals: d.totals,
      me: { isEvaluator: mine },
      can: { evaluate, decide, decideNow: decide && !(d.category.fourEyes && mine) },
    };
  });
}

export async function takeEntryAction(entryId: string) {
  return await run('prequalification:evaluate', { surface: 'prequalification/entry', action: 'take' }, async (ctx) => {
    await getContainer().prequalReview.take(ctx, id(entryId));
  }, ['/admin/vendors/prequalification']);
}

export async function saveScoresAction(entryId: string, scores: unknown) {
  return await run('prequalification:evaluate', { surface: 'prequalification/entry', action: 'score' }, async (ctx) => {
    const list = Array.isArray(scores) ? scores.slice(0, 60) : [];
    const clean = list.map((s) => {
      const r = obj(s);
      return { questionId: id(r.questionId), score: typeof r.score === 'number' ? r.score : Number.NaN, comment: str(r.comment, 500) };
    });
    await getContainer().prequalReview.saveScores(ctx, id(entryId), clean);
  });
}

export async function approveEntryAction(entryId: string, conditions: unknown) {
  return await run('prequalification:decide', { surface: 'prequalification/entry', action: 'approve' }, async (ctx) => {
    const c = obj(conditions);
    return await getContainer().prequalReview.approve(ctx, id(entryId), { maxOrderValue: str(c.maxOrderValue, 20), note: str(c.note) }, businessDate());
  }, ['/admin/vendors/prequalification']);
}

export async function rejectEntryAction(entryId: string, reason: unknown) {
  return await run('prequalification:decide', { surface: 'prequalification/entry', action: 'reject' }, async (ctx) => {
    await getContainer().prequalReview.reject(ctx, id(entryId), reasonOf(reason));
  }, ['/admin/vendors/prequalification']);
}

export async function reviseEntryAction(entryId: string, note: string, due: string) {
  return await run('prequalification:decide', { surface: 'prequalification/entry', action: 'revise' }, async (ctx) => {
    await getContainer().prequalReview.requestRevision(ctx, id(entryId), str(note, 1000), str(due, 12));
  }, ['/admin/vendors/prequalification']);
}

export async function suspendEntryAction(entryId: string, reason: unknown) {
  return await run('prequalification:decide', { surface: 'prequalification/entry', action: 'suspend' }, async (ctx) => {
    await getContainer().prequalReview.suspend(ctx, id(entryId), reasonOf(reason));
  }, ['/admin/vendors/prequalification']);
}

export async function reinstateEntryAction(entryId: string) {
  return await run('prequalification:decide', { surface: 'prequalification/entry', action: 'reinstate' }, async (ctx) => {
    await getContainer().prequalReview.reinstate(ctx, id(entryId));
  }, ['/admin/vendors/prequalification']);
}

export async function revokeEntryAction(entryId: string, reason: unknown) {
  return await run('prequalification:decide', { surface: 'prequalification/entry', action: 'revoke' }, async (ctx) => {
    await getContainer().prequalReview.revoke(ctx, id(entryId), reasonOf(reason));
  }, ['/admin/vendors/prequalification']);
}
