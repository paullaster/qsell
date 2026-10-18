'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { isProjectCommand, isTaskCommand, type ProjectCommand } from './domain/project';
import { ProjectError } from './errors';
import { run } from './action-runner';
import type { ProjectContext, ProjectInput, TaskInput } from './service';

const projects = () => getContainer().projects;
const LIST = '/admin/projects';

const COMMAND_PERMISSION: Record<ProjectCommand, PermissionKey> = {
  open: 'projects:open',
  hold: 'projects:hold',
  resume: 'projects:open',
  complete: 'projects:complete',
  close: 'projects:close',
  cancel: 'projects:cancel',
  reopen: 'projects:open',
};

async function abilities() {
  const [update, open, hold, complete, close, cancel, create] = await Promise.all([
    canPermission('projects:update'),
    canPermission('projects:open'),
    canPermission('projects:hold'),
    canPermission('projects:complete'),
    canPermission('projects:close'),
    canPermission('projects:cancel'),
    canPermission('projects:create'),
  ]);
  return { update, open, hold, complete, close, cancel, create };
}

async function shown(ctx: ProjectContext, id: string) {
  const data = await projects().detail(ctx.companyId, id);
  if (data === null) throw new ProjectError('NOT_FOUND', 'That project does not exist.');
  const can = await abilities();
  return { ...data, can };
}

/** Where a new project starts: the books' currency, when the books have been set up. */
export async function projectStartAction() {
  return await run('projects:create', { surface: 'projects/new', action: 'start' }, async (ctx) => ({
    currency: await projects().booksCurrency(ctx.companyId),
  }));
}

export async function listProjectsAction(filter: { status?: string; query?: string; cursor?: string } = {}) {
  return await run('projects:read', { surface: 'projects', action: 'list' }, async (ctx) => {
    const page = await projects().list(ctx.companyId, filter);
    return { ...page, can: { create: await canPermission('projects:create') } };
  });
}

export async function createProjectAction(input: ProjectInput) {
  return await run(
    'projects:create',
    { surface: 'projects/new', action: 'create' },
    async (ctx) => projects().create(ctx, input),
    [LIST],
  );
}

export async function projectDetailAction(id: string) {
  return await run('projects:read', { surface: 'projects/detail', action: 'read' }, async (ctx) => shown(ctx, id));
}

export async function updateProjectAction(id: string, input: ProjectInput & { version: number }) {
  return await run(
    'projects:update',
    { surface: 'projects/detail', action: 'update' },
    async (ctx) => {
      await projects().update(ctx, id, input);
      return shown(ctx, id);
    },
    [LIST],
  );
}

export async function transitionProjectAction(id: string, event: string) {
  if (!isProjectCommand(event)) {
    return await run('projects:read', { surface: 'projects/detail', action: 'transition' }, async () => {
      throw new ProjectError('INVALID', 'That step is not one this project can take.');
    });
  }
  const permission = COMMAND_PERMISSION[event];
  return await run(
    permission,
    { surface: 'projects/detail', action: event },
    async (ctx) => {
      await projects().transition(ctx, id, event);
      return shown(ctx, id);
    },
    [LIST],
  );
}

export async function addProjectTaskAction(projectId: string, input: TaskInput) {
  return await run(
    'projects:update',
    { surface: 'projects/detail', action: 'add-task' },
    async (ctx) => {
      await projects().addTask(ctx, projectId, input);
      return shown(ctx, projectId);
    },
    [LIST],
  );
}

export async function updateProjectTaskAction(projectId: string, taskId: string, input: TaskInput & { version: number }) {
  return await run(
    'projects:update',
    { surface: 'projects/detail', action: 'update-task' },
    async (ctx) => {
      await projects().updateTask(ctx, projectId, taskId, input);
      return shown(ctx, projectId);
    },
    [LIST],
  );
}

export async function transitionProjectTaskAction(projectId: string, taskId: string, event: string) {
  if (!isTaskCommand(event)) {
    return await run('projects:update', { surface: 'projects/detail', action: 'task-step' }, async () => {
      throw new ProjectError('INVALID', 'That step is not one this task can take.');
    });
  }
  return await run(
    'projects:update',
    { surface: 'projects/detail', action: 'task-step' },
    async (ctx) => {
      await projects().transitionTask(ctx, projectId, taskId, event);
      return shown(ctx, projectId);
    },
    [LIST],
  );
}

export async function listProjectTasksAction(projectId: string, cursor?: string) {
  return await run('projects:read', { surface: 'projects/detail', action: 'tasks' }, async (ctx) => {
    const page = await projects().tasks(ctx.companyId, projectId, cursor);
    if (page === null) throw new ProjectError('NOT_FOUND', 'That project does not exist.');
    return page;
  });
}
