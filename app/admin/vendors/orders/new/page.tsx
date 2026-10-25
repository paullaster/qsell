import { NewPoClient } from '@/components/admin/vendors/PoEditorClient';
import { businessDate } from '@/server/kernel/numbering/business-date';

export default function Page() {
  return <NewPoClient today={businessDate()} />;
}
