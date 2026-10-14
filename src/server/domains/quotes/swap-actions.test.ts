import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';

const requireQuoteAuthor = vi.fn();
const requirePermission = vi.fn();
const planQuoteSwap = vi.fn();
const planSectionSwap = vi.fn();
const addSection = vi.fn();
const draftFromTemplate = vi.fn();
const defaultDraft = vi.fn();
const chooseCustomer = vi.fn();
const chooseTemplateCustomer = vi.fn();

vi.mock('./authoring', () => ({
  requireQuoteAuthor: (...args: unknown[]) => requireQuoteAuthor(...args) as unknown,
}));
vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
  canPermission: vi.fn(),
}));
vi.mock('./template-swap-service', () => ({
  TemplateSwapService: class {
    planQuoteSwap = planQuoteSwap;
    planSectionSwap = planSectionSwap;
    addSection = addSection;
    draftFromTemplate = draftFromTemplate;
    defaultDraft = defaultDraft;
  },
}));
vi.mock('./quote-form-service', () => ({
  QuoteFormService: class {
    chooseCustomer = chooseCustomer;
    chooseTemplateCustomer = chooseTemplateCustomer;
  },
}));

const swap = await import('./swap-actions');
const forms = await import('./form-actions');
const denied = () =>
  new AccessDeniedError('quotes:update', { allowed: false, reason: 'deny-grant' });

beforeEach(() => {
  for (const fn of [requireQuoteAuthor, requirePermission])
    fn.mockReset().mockResolvedValue('user-1');
  for (const fn of [
    planQuoteSwap,
    planSectionSwap,
    addSection,
    draftFromTemplate,
    defaultDraft,
    chooseCustomer,
    chooseTemplateCustomer,
  ]) {
    fn.mockReset().mockResolvedValue({ answer: 1 });
  }
});

describe('the quote form actions', () => {
  const cases: [string, () => Promise<unknown>, ReturnType<typeof vi.fn>][] = [
    [
      'plan a quote template switch',
      () => swap.planQuoteTemplateSwapAction({ lines: [] }, 't1'),
      planQuoteSwap,
    ],
    [
      'plan a section template switch',
      () => swap.planSectionTemplateSwapAction({ lines: [] }, 's1', 't1'),
      planSectionSwap,
    ],
    [
      'add a section from a template',
      () => swap.addSectionFromTemplateAction({ lines: [] }, 't1'),
      addSection,
    ],
    [
      'choose a customer',
      () => forms.chooseQuoteCustomerAction({ lines: [] }, 'c1'),
      chooseCustomer,
    ],
    [
      'choose a template customer',
      () => forms.chooseTemplateCustomerAction({ lines: [] }, 'c1'),
      chooseTemplateCustomer,
    ],
  ];

  it.each(cases)(
    '%s: runs for someone allowed to author quotes and returns the data',
    async (_name, call, service) => {
      expect(await call()).toEqual({ ok: true, data: { answer: 1 } });
      expect(requireQuoteAuthor).toHaveBeenCalledTimes(1);
      expect(service).toHaveBeenCalledTimes(1);
    },
  );

  it.each(cases)(
    '%s: does nothing for someone who is not allowed',
    async (_name, call, service) => {
      requireQuoteAuthor.mockRejectedValue(denied());
      expect(await call()).toEqual({ ok: false, error: 'You do not have permission to do that.' });
      expect(service).not.toHaveBeenCalled();
    },
  );

  it('starting a quote needs the create permission, and does nothing without it', async () => {
    expect(await swap.startQuoteFromTemplateAction('t1', undefined)).toEqual({
      ok: true,
      data: { answer: 1 },
    });
    expect(requirePermission).toHaveBeenCalledWith('quotes:create');
    expect(await swap.getDefaultQuoteDraftAction()).toEqual({ ok: true, data: { answer: 1 } });

    requirePermission.mockRejectedValue(denied());
    expect(await swap.startQuoteFromTemplateAction('t1', undefined)).toMatchObject({ ok: false });
    expect(await swap.getDefaultQuoteDraftAction()).toMatchObject({ ok: false });
    expect(draftFromTemplate).toHaveBeenCalledTimes(1);
  });

  it('refuses ids that are not strings, before the service is reached', async () => {
    const bad = 5 as unknown as string;
    expect(await swap.planQuoteTemplateSwapAction({}, bad)).toMatchObject({ ok: false });
    expect(await swap.planSectionTemplateSwapAction({}, bad, 't')).toMatchObject({ ok: false });
    expect(await swap.planSectionTemplateSwapAction({}, 's', bad)).toMatchObject({ ok: false });
    expect(await swap.addSectionFromTemplateAction({}, bad)).toMatchObject({ ok: false });
    expect(await forms.chooseQuoteCustomerAction({}, bad)).toMatchObject({ ok: false });
    expect(await forms.chooseTemplateCustomerAction({}, bad)).toMatchObject({ ok: false });
    expect(await swap.startQuoteFromTemplateAction(bad)).toMatchObject({ ok: false });
    for (const fn of [
      planQuoteSwap,
      planSectionSwap,
      addSection,
      chooseCustomer,
      chooseTemplateCustomer,
      draftFromTemplate,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('passes the browser’s form and choice on untouched for the service to check', async () => {
    const form = { lines: [{ productId: 'p' }] };
    await swap.planQuoteTemplateSwapAction(form, null);
    expect(planQuoteSwap).toHaveBeenCalledWith(form, null);
    await forms.chooseQuoteCustomerAction(form, null);
    expect(chooseCustomer).toHaveBeenCalledWith(form, null);
  });

  it('shows the service’s own message when it refuses, and hides anything unexpected', async () => {
    planQuoteSwap.mockRejectedValue(
      new Error('The selected quote template is no longer available.'),
    );
    expect(await swap.planQuoteTemplateSwapAction({}, 't1')).toEqual({
      ok: false,
      error: 'The selected quote template is no longer available.',
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    planQuoteSwap.mockRejectedValue(new TypeError('cannot read properties of undefined'));
    const result = await swap.planQuoteTemplateSwapAction({}, 't1');
    expect(result).toEqual({ ok: false, error: 'Something went wrong. Please try again.' });
    log.mockRestore();
  });
});
