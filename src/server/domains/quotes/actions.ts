'use server';

import { revalidatePath } from 'next/cache';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { parseQuoteListRequest } from './quote-list';
import { parseTemplateListRequest } from './template-list';
import { runQuoteAction } from './run';
import type { CatalogueProduct } from '@/lib/catalogue-entry';
import { listProductsAction } from '@/server/domains/catalog/actions';
import { listTradeCustomersAction } from '@/server/domains/customers/master-actions';
import type { KitAllocation } from '@/server/domains/pricing/domain/kits';
import { SalesQuoteService, type QuoteInput, type QuoteTemplateInput } from './service';
import { SectionTemplateService } from './section-template-service';

const service = () => new SalesQuoteService();
const run = runQuoteAction;

/** One page of the quotes list (see `SalesQuoteService.listPage`); the request is untrusted. */
export async function listSalesQuotesPageAction(raw: unknown) {
  return run(async () => {
    await requirePermission('quotes:read');
    const parsed = parseQuoteListRequest(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return service().listPage(parsed.value);
  });
}

export async function getSalesQuoteAction(id: string) {
  await requirePermission('quotes:read');
  return service().get(id);
}

/**
 * The kits on sale, with what the editor needs to show a kit line the way the server will work it
 * out: its cost is its components' cost, and its tax is each component's share at its own rate.
 */
export interface EditorKit {
  productId: string;
  allocation: KitAllocation;
  components: Array<{
    productId: string;
    quantity: number;
    price: number;
    cost: number;
    weight: number | null;
    taxRate: number;
  }>;
}

async function editorKits(): Promise<EditorKit[]> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  return [...(await c.kits.all(company.id)).values()].map((k) => ({
    productId: k.productId,
    allocation: k.allocation,
    components: k.components.map((x) => ({
      productId: x.productId,
      quantity: x.quantity,
      price: x.price,
      cost: x.cost,
      weight: x.weight,
      taxRate: x.taxRate,
    })),
  }));
}

/**
 * What the quote editor and the template screens need up front: the catalogue to add items from,
 * the kits (so a kit's cost and tax show as the server will work them out) and the settings. The
 * lists people choose from (customers, templates, currencies) are not here: they are searched on
 * the server as the person types.
 */
export async function getSalesQuoteEditorDataAction() {
  await requirePermission('quotes:read');
  const [products, settings, kits] = await Promise.all([
    listProductsAction(),
    service().getSettings(),
    editorKits(),
  ]);
  // Only what the editors use: descriptions, specifications and media would make a long catalogue
  // slow to open, and nothing on the screen shows them.
  const slim: CatalogueProduct[] = products.map((p) => ({
    id: p.id,
    sku: p.sku,
    stockCode: p.stockCode,
    name: p.name,
    category: p.category,
    brand: p.brand,
    isSellable: p.isSellable,
    price: p.price,
    costPrice: p.costPrice,
    taxRate: p.taxRate,
    isTaxInclusive: p.isTaxInclusive,
    stockQuantity: p.stockQuantity,
    reservedQuantity: p.reservedQuantity,
    imageUrl: p.imageUrl,
  }));
  return { products: slim, settings, kits };
}

/** One page of the quote templates list; the request is untrusted. */
export async function listSalesQuoteTemplatesPageAction(raw: unknown) {
  return run(async () => {
    await requirePermission('quotes:read');
    const parsed = parseTemplateListRequest(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return service().listTemplatesPage(parsed.value);
  });
}

/** One quote template in full, for its editor. */
export async function getSalesQuoteTemplateAction(id: string) {
  return run(async () => {
    await requirePermission('quotes:read');
    if (typeof id !== 'string') throw new Error('Invalid template.');
    const template = await service().getTemplate(id);
    if (template === null) throw new Error('That template is no longer available.');
    return template;
  });
}

/** One page of the section templates list; the request is untrusted. */
export async function listSectionTemplatesPageAction(raw: unknown) {
  return run(async () => {
    await requirePermission('quotes:read');
    const parsed = parseTemplateListRequest(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return new SectionTemplateService().listPage(parsed.value);
  });
}

/** One section template in full, for its editor. */
export async function getSectionTemplateAction(id: string) {
  return run(async () => {
    await requirePermission('quotes:read');
    if (typeof id !== 'string') throw new Error('Invalid template.');
    const template = await new SectionTemplateService().get(id);
    if (template === null) throw new Error('That section template is no longer available.');
    return template;
  });
}

export async function saveSalesQuoteTemplateAction(id: string | null, input: QuoteTemplateInput) {
  const userId = await requirePermission(id ? 'quotes:update' : 'quotes:create');
  const template = await service().saveTemplate(userId, id, input);
  revalidatePath('/admin/quotes');
  return template;
}

export async function saveSectionTemplateAction(id: string | null, input: unknown) {
  return run(async () => {
    const userId = await requirePermission(id ? 'quotes:update' : 'quotes:create');
    const template = await new SectionTemplateService().save(userId, id, input);
    revalidatePath('/admin/quotes');
    return template;
  });
}

export async function duplicateSectionTemplateAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:create');
    const template = await new SectionTemplateService().duplicate(userId, id);
    revalidatePath('/admin/quotes');
    return template;
  });
}

export async function archiveSectionTemplateAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:delete');
    await new SectionTemplateService().archive(userId, id);
    revalidatePath('/admin/quotes');
  });
}

/** Quotes of any status to choose from when making a template. */
export async function searchSalesQuotesAction(term: string, status?: string) {
  await requirePermission('quotes:read');
  return service().searchQuotes(term, { status: status || undefined });
}

/** What a quote would make as a template, for the template editor to start from. */
export async function templateDraftFromQuoteAction(quoteId: string, keepCustomer = false) {
  await requirePermission('quotes:create');
  return service().templateDraftFromQuote(quoteId, keepCustomer);
}

export async function duplicateSalesQuoteTemplateAction(id: string) {
  const userId = await requirePermission('quotes:create');
  const template = await service().duplicateTemplate(userId, id);
  revalidatePath('/admin/quotes');
  return template;
}

export async function archiveSalesQuoteTemplateAction(id: string) {
  const userId = await requirePermission('quotes:delete');
  await service().archiveTemplate(userId, id);
  revalidatePath('/admin/quotes');
}

export async function setDefaultSalesQuoteTemplateAction(id: string) {
  const userId = await requirePermission('quotes:update');
  await service().setDefaultTemplate(userId, id);
  revalidatePath('/admin/quotes');
}

export async function createSalesQuoteAction(input: QuoteInput) {
  return run(async () => {
    const userId = await requirePermission('quotes:create');
    const quote = await service().create(userId, input);
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function updateSalesQuoteAction(id: string, input: QuoteInput) {
  return run(async () => {
    const userId = await requirePermission('quotes:update');
    const quote = await service().update(userId, id, input);
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function reviseSalesQuoteAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:create');
    const quote = await service().revise(userId, id);
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function approveSalesQuoteAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:approve');
    const quote = await service().approve(userId, id);
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function resubmitSalesQuoteApprovalAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:update');
    const quote = await service().resubmitApproval(userId, id);
    revalidatePath('/admin/quotes');
    revalidatePath('/admin/approvals', 'layout');
    return quote;
  });
}

export async function sendSalesQuoteAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:update');
    const quote = await service().send(userId, id);
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function generateSalesQuotePdfAction(id: string) {
  return run(async () => {
    await requirePermission('quotes:read');
    return service().generatePdf(id);
  });
}

export async function respondToSalesQuoteAction(id: string, accepted: boolean) {
  return run(async () => {
    const userId = await requirePermission('quotes:approve');
    const quote = await service().changeStatus(id, userId, accepted ? 'accepted' : 'rejected');
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function cancelSalesQuoteAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:delete');
    const quote = await service().changeStatus(id, userId, 'cancelled');
    revalidatePath('/admin/quotes');
    return quote;
  });
}

export async function convertSalesQuoteToOrderAction(id: string) {
  return run(async () => {
    const userId = await requirePermission('quotes:approve');
    await requirePermission('orders:create');
    const order = await service().convertToOrder(userId, id);
    revalidatePath('/admin/quotes');
    revalidatePath('/admin/orders');
    revalidatePath('/admin/inventory');
    return order;
  });
}

export async function updateSalesQuoteSettingsAction(minimumGrossMarginPercent: number) {
  return run(async () => {
    const userId = await requirePermission('settings:manage');
    const settings = await service().updateSettings(userId, minimumGrossMarginPercent);
    revalidatePath('/admin/quotes');
    return settings;
  });
}

export async function getPublicSalesQuoteAction(token: string) {
  return service().getShared(token);
}

export async function respondToPublicSalesQuoteAction(token: string, accepted: boolean) {
  const status = await service().respondShared(token, accepted);
  revalidatePath('/admin/quotes');
  return status;
}

export async function getSalesQuoteCapabilitiesAction() {
  const [canCreate, canUpdate, canApprove, canDelete, canConfigure] = await Promise.all([
    canPermission('quotes:create'),
    canPermission('quotes:update'),
    canPermission('quotes:approve'),
    canPermission('quotes:delete'),
    canPermission('settings:manage'),
  ]);
  return { canCreate, canUpdate, canApprove, canDelete, canConfigure };
}
