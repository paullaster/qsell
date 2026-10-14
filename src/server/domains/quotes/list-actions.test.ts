import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';

const requirePermission = vi.fn();
const listPage = vi.fn();
const listTemplatesPage = vi.fn();
const getTemplate = vi.fn();
const sectionListPage = vi.fn();
const sectionGet = vi.fn();

vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
  canPermission: vi.fn(),
}));
vi.mock('@/server/domains/catalog/actions', () => ({ listProductsAction: vi.fn() }));
vi.mock('@/server/domains/customers/master-actions', () => ({ listTradeCustomersAction: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/di/container', () => ({ getContainer: vi.fn() }));
vi.mock('./service', () => ({
  SalesQuoteService: class {
    listPage = listPage;
    listTemplatesPage = listTemplatesPage;
    getTemplate = getTemplate;
  },
}));
vi.mock('./section-template-service', () => ({
  SectionTemplateService: class {
    listPage = sectionListPage;
    get = sectionGet;
  },
}));

const actions = await import('./actions');
const denied = () => new AccessDeniedError('quotes:read', { allowed: false, reason: 'deny-grant' });
const page = { rows: [], nextCursor: null };

beforeEach(() => {
  requirePermission.mockReset().mockResolvedValue('user-1');
  listPage.mockReset().mockResolvedValue(page);
  listTemplatesPage.mockReset().mockResolvedValue(page);
  sectionListPage.mockReset().mockResolvedValue(page);
  getTemplate.mockReset().mockResolvedValue({ id: 't1' });
  sectionGet.mockReset().mockResolvedValue({ id: 's1' });
});

describe('the paged list actions', () => {
  it('list quotes: needs quotes:read, passes the parsed request on, and returns the page', async () => {
    const result = await actions.listSalesQuotesPageAction({
      query: ' abc ',
      status: 'sent',
      limit: 500,
    });
    expect(requirePermission).toHaveBeenCalledWith('quotes:read');
    expect(listPage).toHaveBeenCalledWith({
      query: 'abc',
      status: 'sent',
      limit: 100,
      after: null,
    });
    expect(result).toEqual({ ok: true, data: page });
  });

  it('list quotes: refuses a bad request, and someone without permission', async () => {
    for (const raw of [{ status: 'nope' }, { limit: 0 }, { cursor: 'forged' }, 'x']) {
      expect(await actions.listSalesQuotesPageAction(raw)).toMatchObject({ ok: false });
    }
    expect(listPage).not.toHaveBeenCalled();
    requirePermission.mockRejectedValue(denied());
    expect(await actions.listSalesQuotesPageAction({})).toEqual({
      ok: false,
      error: 'You do not have permission to do that.',
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  it('list templates: same rules, for both kinds', async () => {
    expect(await actions.listSalesQuoteTemplatesPageAction({ status: 'archived' })).toEqual({
      ok: true,
      data: page,
    });
    expect(listTemplatesPage).toHaveBeenCalledWith({
      query: '',
      status: 'archived',
      limit: 25,
      after: null,
    });
    expect(await actions.listSectionTemplatesPageAction({ query: 'tea' })).toEqual({
      ok: true,
      data: page,
    });
    expect(sectionListPage).toHaveBeenCalledWith(expect.objectContaining({ query: 'tea' }));
    for (const call of [
      actions.listSalesQuoteTemplatesPageAction,
      actions.listSectionTemplatesPageAction,
    ]) {
      expect(await call({ status: 'draft' })).toMatchObject({ ok: false });
    }
    requirePermission.mockRejectedValue(denied());
    expect(await actions.listSalesQuoteTemplatesPageAction({})).toMatchObject({ ok: false });
    expect(await actions.listSectionTemplatesPageAction({})).toMatchObject({ ok: false });
    expect(listTemplatesPage).toHaveBeenCalledTimes(1);
    expect(sectionListPage).toHaveBeenCalledTimes(1);
  });

  it('get a template for its editor: returns it, says when it is gone, and checks the id and permission', async () => {
    expect(await actions.getSalesQuoteTemplateAction('t1')).toEqual({
      ok: true,
      data: { id: 't1' },
    });
    expect(await actions.getSectionTemplateAction('s1')).toEqual({ ok: true, data: { id: 's1' } });
    getTemplate.mockResolvedValue(null);
    sectionGet.mockResolvedValue(null);
    expect(await actions.getSalesQuoteTemplateAction('t1')).toEqual({
      ok: false,
      error: 'That template is no longer available.',
    });
    expect(await actions.getSectionTemplateAction('s1')).toMatchObject({ ok: false });
    expect(await actions.getSalesQuoteTemplateAction(5 as unknown as string)).toMatchObject({
      ok: false,
    });
    requirePermission.mockRejectedValue(denied());
    getTemplate.mockClear();
    expect(await actions.getSalesQuoteTemplateAction('t1')).toMatchObject({ ok: false });
    expect(getTemplate).not.toHaveBeenCalled();
  });
});
