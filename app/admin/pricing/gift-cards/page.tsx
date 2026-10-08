import { listGiftCardsAction } from '@/server/domains/pricing/retrospective-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { GiftCardsClient } from '@/components/admin/pricing/GiftCardsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminGiftCardsPage() {
  const [cards, canManage] = await Promise.all([
    listGiftCardsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!cards.ok) return <ErrorNote message={cards.error} />;
  return <GiftCardsClient initial={cards.data} canManage={canManage} />;
}
