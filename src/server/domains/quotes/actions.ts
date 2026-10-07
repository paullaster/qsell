'use server';

import { revalidatePath } from 'next/cache';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { listProductsAction } from '@/server/domains/catalog/actions';
import { listTradeCustomersAction } from '@/server/domains/customers/master-actions';
import { SalesQuoteService, type QuoteInput, type QuoteTemplateInput } from './service';

const service = () => new SalesQuoteService();

export async function listSalesQuotesAction() {
  await requirePermission('quotes:read');
  return service().list();
}

export async function getSalesQuoteAction(id: string) {
  await requirePermission('quotes:read');
  return service().get(id);
}

export async function getSalesQuoteEditorDataAction() {
  await requirePermission('quotes:read');
  const [products, customers, settings, templates] = await Promise.all([
    listProductsAction(),
    listTradeCustomersAction(),
    service().getSettings(),
    service().listTemplates(),
  ]);
  return { products, customers, settings, templates };
}

export async function listSalesQuoteTemplatesAction() {
  await requirePermission('quotes:read');
  return service().listTemplates();
}

export async function saveSalesQuoteTemplateAction(id: string | null, input: QuoteTemplateInput) {
  const userId = await requirePermission(id ? 'quotes:update' : 'quotes:create');
  const template = await service().saveTemplate(userId, id, input);
  revalidatePath('/admin/quotes');
  return template;
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
  const userId = await requirePermission('quotes:create');
  const quote = await service().create(userId, input);
  revalidatePath('/admin/quotes');
  return quote;
}

export async function updateSalesQuoteAction(id: string, input: QuoteInput) {
  const userId = await requirePermission('quotes:update');
  const quote = await service().update(userId, id, input);
  revalidatePath('/admin/quotes');
  return quote;
}

export async function reviseSalesQuoteAction(id: string) {
  const userId = await requirePermission('quotes:create');
  const quote = await service().revise(userId, id);
  revalidatePath('/admin/quotes');
  return quote;
}

export async function approveSalesQuoteAction(id: string) {
  const userId = await requirePermission('quotes:approve');
  const quote = await service().approve(userId, id);
  revalidatePath('/admin/quotes');
  return quote;
}

export async function resubmitSalesQuoteApprovalAction(id: string) {
  const userId = await requirePermission('quotes:update');
  const quote = await service().resubmitApproval(userId, id);
  revalidatePath('/admin/quotes');
  revalidatePath('/admin/approvals', 'layout');
  return quote;
}

export async function sendSalesQuoteAction(id: string) {
  const userId = await requirePermission('quotes:update');
  const quote = await service().send(userId, id);
  revalidatePath('/admin/quotes');
  return quote;
}

export async function generateSalesQuotePdfAction(id: string) {
  await requirePermission('quotes:read');
  return service().generatePdf(id);
}

export async function respondToSalesQuoteAction(id: string, accepted: boolean) {
  const userId = await requirePermission('quotes:approve');
  const quote = await service().changeStatus(id, userId, accepted ? 'accepted' : 'rejected');
  revalidatePath('/admin/quotes');
  return quote;
}

export async function cancelSalesQuoteAction(id: string) {
  const userId = await requirePermission('quotes:delete');
  const quote = await service().changeStatus(id, userId, 'cancelled');
  revalidatePath('/admin/quotes');
  return quote;
}

export async function convertSalesQuoteToOrderAction(id: string) {
  const userId = await requirePermission('quotes:approve');
  await requirePermission('orders:create');
  const order = await service().convertToOrder(userId, id);
  revalidatePath('/admin/quotes');
  revalidatePath('/admin/orders');
  revalidatePath('/admin/inventory');
  return order;
}

export async function updateSalesQuoteSettingsAction(minimumGrossMarginPercent: number) {
  const userId = await requirePermission('settings:manage');
  const settings = await service().updateSettings(userId, minimumGrossMarginPercent);
  revalidatePath('/admin/quotes');
  return settings;
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
