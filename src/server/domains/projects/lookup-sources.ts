import { eq } from 'drizzle-orm';
import { customers, projects } from '@/server/db/drizzle/schema';
import { PROJECT_STATUS_INFO } from '@/lib/project-statuses';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { PROJECT_STATUSES, isProjectStatus } from './domain/project';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const projectCustomers = tableSource({
  key: 'project-customers',
  permission: 'projects:read',
  table: customers,
  id: customers.id,
  label: customers.name,
  searchColumns: [customers.name, customers.number, customers.phone, customers.email],
  select: { number: customers.number, phone: customers.phone },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(customers.companyId, companyId), eq(customers.isActive, true)];
  },
  toOption: (row) => {
    const description = [row.number, row.phone].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
    return { id: text(row.id), label: text(row.label), description: description === '' ? null : description };
  },
});

const projectStatuses = staticSource({
  key: 'project-statuses',
  permission: 'projects:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return PROJECT_STATUSES.map((status) => ({ id: status, label: PROJECT_STATUS_INFO[status].label, description: null }));
  },
});

const projectList = tableSource({
  key: 'projects',
  permission: 'projects:read',
  table: projects,
  id: projects.id,
  label: projects.name,
  searchColumns: [projects.name, projects.number],
  select: { number: projects.number, status: projects.status },
  scope: ({ companyId, filters }) => {
    const chosen = acceptFilters(filters, { status: PROJECT_STATUSES }).status;
    const where = [eq(projects.companyId, companyId)];
    if (typeof chosen === 'string' && isProjectStatus(chosen)) where.push(eq(projects.status, chosen));
    return where;
  },
  toOption: (row) => {
    const status = text(row.status);
    return {
      id: text(row.id),
      label: text(row.label),
      description: text(row.number) === '' ? null : text(row.number),
      badge: isProjectStatus(status) ? PROJECT_STATUS_INFO[status].label : null,
    };
  },
});

export const PROJECT_LOOKUP_SOURCES: LookupSource[] = [projectCustomers, projectStatuses, projectList];
