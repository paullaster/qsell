/** Closed catalog of dimension option strings — UI select + server validation only. */
export const DIMENSION_OPTION_STRINGS = [
  'company',
  'branch',
  'department',
  'warehouse',
  'franchise',
  'site',
  'project',
  'country',
  'campaign',
  'channel',
] as const;

export type DimensionOptionString = (typeof DIMENSION_OPTION_STRINGS)[number];

export const DIMENSION_OPTION_STRING_LABELS: Record<DimensionOptionString, string> = {
  company: 'Company',
  branch: 'Branch',
  department: 'Department',
  warehouse: 'Warehouse',
  franchise: 'Franchise',
  site: 'Site',
  project: 'Project',
  country: 'Country',
  campaign: 'Campaign',
  channel: 'Channel',
};

export function isDimensionOptionString(value: string): value is DimensionOptionString {
  return (DIMENSION_OPTION_STRINGS as readonly string[]).includes(value);
}
