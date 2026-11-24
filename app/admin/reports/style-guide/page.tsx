import type { Metadata } from 'next';
import { requirePermission } from '@/server/domains/access-control/guard';
import { StyleGuide } from '@/components/reports/hub/StyleGuide';

export const metadata: Metadata = { title: 'Report style guide' };

export default async function StyleGuidePage() {
  await requirePermission('reports:read');
  return <StyleGuide />;
}
