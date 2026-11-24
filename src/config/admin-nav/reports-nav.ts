import { plainText } from '@/lib/reports/messages';
import {
  FAMILY_CODES,
  FAMILY_LABELS,
  REPORTS,
  type FamilyCode,
} from '@/server/domains/reports/registry';
import type { AdminNavIconName, AdminNavItem } from './types';

/**
 * The Reports section of the navigation, built from the report registry so a report is in the menu the moment it is
 * registered and nowhere else: one module per family (Sales, Finance, Inventory, ...), each listing its reports. A module's
 * own link opens the Reports page narrowed to that module. The Business Overview is the home screen and is not listed.
 */

const FAMILY_ICONS: Record<FamilyCode, AdminNavIconName> = {
  executive: 'LayoutDashboard',
  sales: 'ShoppingBag',
  pos: 'Receipt',
  inventory: 'Boxes',
  finance: 'Landmark',
  tax: 'FileCheck',
  customers: 'Users',
  vendors: 'Building2',
  delivery: 'Truck',
  projects: 'FolderKanban',
  people: 'UserCog',
  operations: 'Settings',
};

export function reportsNavModules(): AdminNavItem[] {
  const modules: AdminNavItem[] = [];
  for (const family of FAMILY_CODES) {
    const reports = REPORTS.filter((r) => r.family === family && r.view !== 'overview');
    if (reports.length === 0) continue;
    const label = plainText(FAMILY_LABELS[family]);
    modules.push({
      id: `reports-module-${family}`,
      title: label,
      name: `reports-module-${family}`,
      href: `/admin/reports?module=${family}`,
      description: `Every ${label.toLowerCase()} report you may open`,
      icon: FAMILY_ICONS[family],
      subLinks: reports.map((r): AdminNavItem => ({
        id: `report-${r.code}`,
        title: plainText(r.titleId),
        name: `report-${r.code}`,
        href: r.href ?? `/admin/reports/${r.code}`,
        description: plainText(r.questionId),
        permission: r.permissions,
        permissionAll: r.permissions,
      })),
    });
  }
  return modules;
}
