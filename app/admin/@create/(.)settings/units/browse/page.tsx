import { UnitsBrowseModal } from '@/components/admin/UnitsBrowseModal';
import { unitsPageAction } from '@/server/domains/units/actions';
import { canPermission } from '@/server/domains/access-control/guard';

export default function InterceptedBrowseUnitsPage() {
  return (
    <UnitsBrowseModal firstPage={unitsPageAction({})} canManage={canPermission('units:manage')} />
  );
}
