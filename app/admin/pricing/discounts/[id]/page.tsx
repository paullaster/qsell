import { inArray } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products } from '@/server/db/drizzle/schema';
import {
  getDiscountLookupsAction,
  getDiscountRuleAction,
} from '@/server/domains/pricing/discount-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DiscountDetailClient } from '@/components/admin/pricing/DiscountDetailClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function DiscountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, lookups, canManage] = await Promise.all([
    getDiscountRuleAction(id),
    getDiscountLookupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!detail.ok) return <ErrorNote message={detail.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  const named = detail.data.rule.target.productIds ?? [];
  const rows = named.length
    ? await drizzleDb
        .select({ id: products.id, name: products.name, sku: products.sku })
        .from(products)
        .where(inArray(products.id, named))
    : [];
  return (
    <DiscountDetailClient
      detail={detail.data}
      lookups={lookups.data}
      productNames={Object.fromEntries(rows.map((p) => [p.id, `${p.name} (${p.sku})`]))}
      canManage={canManage}
    />
  );
}
