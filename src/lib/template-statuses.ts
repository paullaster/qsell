/** The states a template list can be filtered by. */
export const TEMPLATE_STATUS_FILTERS = ['all', 'active', 'archived'] as const;
export type TemplateStatusFilter = (typeof TEMPLATE_STATUS_FILTERS)[number];

const LABELS: Record<TemplateStatusFilter, string> = {
  all: 'All statuses',
  active: 'Active',
  archived: 'Archived',
};

export const templateStatusLabel = (status: string): string =>
  Object.hasOwn(LABELS, status) ? LABELS[status as TemplateStatusFilter] : status;
