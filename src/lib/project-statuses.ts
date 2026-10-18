import type { ProjectStatus, TaskStatus } from '@/server/domains/projects/domain/project';

type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

export const PROJECT_STATUS_INFO: Record<ProjectStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'gray' },
  open: { label: 'Open', tone: 'sky' },
  on_hold: { label: 'On hold', tone: 'amber' },
  completed: { label: 'Completed', tone: 'green' },
  closed: { label: 'Closed', tone: 'gray' },
  cancelled: { label: 'Cancelled', tone: 'red' },
};

export const TASK_STATUS_INFO: Record<TaskStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'sky' },
  completed: { label: 'Done', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'red' },
};
