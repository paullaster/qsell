import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { has, orElse } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  customers,
  financeSettings,
  projectEvents,
  projectTasks,
  projects,
  users,
  type ProjectRow,
  type ProjectStatus,
  type ProjectTaskStatus,
} from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate, formatBusinessTime } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, pageOf, searchText } from '@/server/domains/settings/paging';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { ProjectError } from './errors';
import {
  applyProjectCommand,
  applyTaskCommand,
  budgetWarning,
  checkAmount,
  checkCode,
  checkCurrency,
  checkCustomerId,
  checkDates,
  checkDescription,
  checkName,
  commandRefusal,
  isProjectCommand,
  isProjectStatus,
  isTaskCommand,
  normalizeAmount,
  normalizeCode,
  normalizeCurrency,
  projectCapabilities,
  projectIsEditable,
  taskCapabilities,
  type ProjectCapabilities,
  type ProjectCommand,
  type TaskCommand,
  type TaskStatus,
} from './domain/project';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type Reader = Pick<DrizzleDb, 'select'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_PAGE = 50;

export interface ProjectContext {
  companyId: string;
  actor: Actor;
  origin: Record<string, unknown>;
}

export interface ProjectInput {
  name: string;
  description: string | null;
  customerId: string | null;
  billable: boolean;
  currency: string;
  budgetAmount: string;
  startOn: string | null;
  endOn: string | null;
  idempotencyKey?: string | null;
}

export interface TaskInput {
  code: string;
  name: string;
  description: string | null;
  budgetAmount: string;
}

export interface ProjectListQuery {
  status?: string;
  query?: string;
  cursor?: string | null;
}

export interface TaskView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: TaskStatus;
  budgetAmount: string;
  version: number;
  capabilities: ReturnType<typeof taskCapabilities>;
}

export interface ProjectDetail {
  project: {
    id: string;
    number: string;
    name: string;
    description: string | null;
    status: ProjectStatus;
    billable: boolean;
    currency: string;
    budgetAmount: string;
    startOn: string | null;
    endOn: string | null;
    customerId: string | null;
    customerName: string | null;
    version: number;
    taskBudget: string;
    budgetNote: string | null;
    createdAt: string;
  };
  tasks: TaskView[];
  tasksNext: string | null;
  events: { id: number; event: string; fromStatus: string | null; toStatus: string | null; at: string; when: string; actor: string }[];
  capabilities: ProjectCapabilities;
}

const refuse = (message: string | null): void => {
  if (message !== null) throw new ProjectError('INVALID', message);
};

function storedAmount(raw: string): string {
  const amount = normalizeAmount(raw);
  if (amount === null) throw new ProjectError('INVALID', 'Enter an amount with up to 4 decimal places.');
  return amount;
}

function finishedAt(row: ProjectRow, command: ProjectCommand, to: ProjectStatus, now: Date): Date | null {
  if (to === 'completed') return now;
  if (command === 'reopen') return null;
  return row.completedAt;
}

function taskEventName(command: TaskCommand): string {
  if (command === 'complete') return 'task_completed';
  if (command === 'cancel') return 'task_cancelled';
  return 'task_reopened';
}

function dayOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function constraintOf(error: unknown): string {
  if (!isUniqueViolation(error)) return '';
  const e = error as {
    constraint?: string;
    constraint_name?: string;
    cause?: { constraint?: string; constraint_name?: string };
  };
  return orElse(e.constraint_name, orElse(e.constraint, orElse(e.cause?.constraint_name, orElse(e.cause?.constraint, ''))));
}

function olderThan(cursor: string | null | undefined): ReturnType<typeof sql> | undefined {
  if (!has(cursor)) return undefined;
  const decoded = decodeCursor(cursor);
  if (decoded === null || !UUID.test(decoded.id) || !/^\d{4}-\d{2}-\d{2}/.test(decoded.k)) return undefined;
  return sql`(${projects.createdAt}, ${projects.id}) < (${decoded.k}::timestamptz, ${decoded.id}::uuid)`;
}

/**
 * The one door for projects. Screens, jobs and imports call this; it is the only writer of the
 * project tables. Every change is committed together with its history.
 */
export class ProjectService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly numbering: NumberSeriesService,
  ) {}

  /** The books' currency, when finance has been set up, so a new budget can start in it. */
  async booksCurrency(companyId: string): Promise<string> {
    const [row] = await this.db.select({ currency: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    return row?.currency ?? '';
  }

  async list(companyId: string, filter: ProjectListQuery = {}) {
    if (has(filter.status) && !isProjectStatus(filter.status)) throw new ProjectError('INVALID', 'That is not a project state.');
    const status = has(filter.status) && isProjectStatus(filter.status) ? filter.status : null;
    const query = searchText({ query: filter.query });
    const pattern = query === '' ? '' : `%${escapeLike(query)}%`;
    const rows = await this.db
      .select({
        project: projects,
        customerName: customers.name,
        stamp: sql<string>`${projects.createdAt}::text`,
      })
      .from(projects)
      .leftJoin(customers, and(eq(customers.id, projects.customerId), eq(customers.companyId, projects.companyId)))
      .where(
        and(
          eq(projects.companyId, companyId),
          status === null ? undefined : eq(projects.status, status),
          olderThan(filter.cursor),
          pattern === '' ? undefined : or(ilike(projects.number, pattern), ilike(projects.name, pattern), ilike(customers.name, pattern)),
        ),
      )
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (row) => ({ k: row.stamp, id: row.project.id }));
    return {
      nextCursor: page.nextCursor,
      rows: page.rows.map((row) => ({
        id: row.project.id,
        number: row.project.number,
        name: row.project.name,
        status: row.project.status,
        customerName: row.customerName,
        currency: row.project.currency,
        budgetAmount: row.project.budgetAmount,
        startOn: row.project.startOn,
        endOn: row.project.endOn,
        createdAt: row.project.createdAt.toISOString(),
      })),
    };
  }

  async detail(companyId: string, id: string): Promise<ProjectDetail | null> {
    return await this.present(this.db, companyId, id);
  }

  async tasks(companyId: string, projectId: string, cursor?: string | null) {
    const project = await this.one(this.db, companyId, projectId);
    if (project === null) return null;
    return await this.taskPage(this.db, project, cursor);
  }

  async create(ctx: ProjectContext, raw: ProjectInput): Promise<{ id: string; number: string }> {
    const input = this.projectInput(raw);
    try {
      return await this.db.transaction(async (tx) => {
        await this.customer(tx, ctx.companyId, input.customerId);
        const id = randomUUID();
        const { number } = await this.numbering.assign(
          'project',
          { companyId: ctx.companyId, branchId: undefined, date: businessDate(), document: { kind: 'project', id }, actor: ctx.actor },
          tx,
        );
        await tx.insert(projects).values({
          id,
          companyId: ctx.companyId,
          number,
          name: input.name,
          description: input.description,
          customerId: input.customerId,
          billable: input.billable,
          currency: input.currency,
          budgetAmount: input.budgetAmount,
          startOn: input.startOn,
          endOn: input.endOn,
          createdBy: ctx.actor.id ?? 'system',
          idempotencyKey: input.idempotencyKey,
        });
        await this.note(tx, ctx, id, 'created', null, 'draft', { number, name: input.name });
        return { id, number };
      });
    } catch (error) {
      if (constraintOf(error) === 'projects_idem_uidx' && has(input.idempotencyKey)) {
        const [existing] = await this.db
          .select({ id: projects.id, number: projects.number })
          .from(projects)
          .where(and(eq(projects.companyId, ctx.companyId), eq(projects.idempotencyKey, input.idempotencyKey)));
        if (existing !== undefined) return existing;
      }
      throw error;
    }
  }

  async update(ctx: ProjectContext, id: string, raw: ProjectInput & { version: number }): Promise<void> {
    const input = this.projectInput(raw);
    this.version(raw.version);
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, ctx.companyId, id);
      this.sameVersion(row.version, raw.version);
      if (!projectIsEditable(row.status)) throw new ProjectError('INVALID', 'This project can no longer be edited.');
      if (input.customerId !== row.customerId && row.status !== 'draft') {
        throw new ProjectError('INVALID', 'The customer can be changed only while the project is a draft.');
      }
      if (input.currency !== row.currency && row.status !== 'draft') {
        throw new ProjectError('INVALID', 'The currency can be changed only while the project is a draft.');
      }
      await this.customer(tx, ctx.companyId, input.customerId);
      const same =
        input.name === row.name &&
        input.description === row.description &&
        input.customerId === row.customerId &&
        input.billable === row.billable &&
        input.currency === row.currency &&
        input.budgetAmount === row.budgetAmount &&
        input.startOn === row.startOn &&
        input.endOn === row.endOn;
      if (same) return;
      await this.save(tx, row, raw.version, {
        name: input.name,
        description: input.description,
        customerId: input.customerId,
        billable: input.billable,
        currency: input.currency,
        budgetAmount: input.budgetAmount,
        startOn: input.startOn,
        endOn: input.endOn,
      });
      await this.note(tx, ctx, row.id, 'updated', row.status, row.status, { name: input.name });
    });
  }

  async transition(ctx: ProjectContext, id: string, command: ProjectCommand): Promise<void> {
    if (!isProjectCommand(command)) throw new ProjectError('INVALID', 'That step is not one this project can take.');
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, ctx.companyId, id);
      const to = applyProjectCommand(row.status, command);
      if (to === null) throw new ProjectError('INVALID', commandRefusal(command));
      const now = new Date();
      await this.save(tx, row, row.version, {
        status: to,
        openedAt: to === 'open' && row.openedAt === null ? now : row.openedAt,
        completedAt: finishedAt(row, command, to, now),
        closedAt: to === 'closed' ? now : row.closedAt,
        cancelledAt: to === 'cancelled' ? now : row.cancelledAt,
      });
      await this.note(tx, ctx, row.id, command, row.status, to, { number: row.number });
    });
  }

  async addTask(ctx: ProjectContext, projectId: string, raw: TaskInput): Promise<void> {
    const input = this.taskInput(raw);
    try {
      await this.db.transaction(async (tx) => {
        const project = await this.locked(tx, ctx.companyId, projectId);
        if (!projectIsEditable(project.status)) throw new ProjectError('INVALID', 'Tasks can be changed while the project is a draft, open, or on hold.');
        await this.unusedCode(tx, project.id, input.code, null);
        const [top] = await tx
          .select({ n: sql<string>`coalesce(max(${projectTasks.sortOrder}), 0)::text` })
          .from(projectTasks)
          .where(eq(projectTasks.projectId, project.id));
        await tx.insert(projectTasks).values({
          companyId: ctx.companyId,
          projectId: project.id,
          code: input.code,
          name: input.name,
          description: input.description,
          budgetAmount: input.budgetAmount,
          sortOrder: Number(top?.n ?? '0') + 1,
        });
        await this.note(tx, ctx, project.id, 'task_added', null, 'open', { code: input.code, name: input.name });
      });
    } catch (error) {
      if (constraintOf(error) === 'project_tasks_project_code_uidx') {
        throw new ProjectError('DUPLICATE_CODE', 'That task code is already used on this project.');
      }
      throw error;
    }
  }

  async updateTask(ctx: ProjectContext, projectId: string, taskId: string, raw: TaskInput & { version: number }): Promise<void> {
    const input = this.taskInput(raw);
    this.version(raw.version);
    try {
      await this.db.transaction(async (tx) => {
        const project = await this.locked(tx, ctx.companyId, projectId);
        const task = await this.task(tx, ctx.companyId, project.id, taskId);
        this.sameVersion(task.version, raw.version);
        const caps = taskCapabilities(project.status, task.status);
        if (!caps.edit) throw new ProjectError('INVALID', 'That task can no longer be edited.');
        if (input.code !== task.code) await this.unusedCode(tx, project.id, input.code, task.id);
        const same = input.code === task.code && input.name === task.name && input.description === task.description && input.budgetAmount === task.budgetAmount;
        if (same) return;
        const [saved] = await tx
          .update(projectTasks)
          .set({
            code: input.code,
            name: input.name,
            description: input.description,
            budgetAmount: input.budgetAmount,
            version: sql`${projectTasks.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(projectTasks.id, task.id), eq(projectTasks.version, raw.version)))
          .returning({ id: projectTasks.id });
        if (saved === undefined) throw new ProjectError('CHANGED', 'This task was changed by someone else. Look again, then try.');
        await this.note(tx, ctx, project.id, 'task_updated', task.status, task.status, { code: input.code, name: input.name });
      });
    } catch (error) {
      if (constraintOf(error) === 'project_tasks_project_code_uidx') {
        throw new ProjectError('DUPLICATE_CODE', 'That task code is already used on this project.');
      }
      throw error;
    }
  }

  async transitionTask(ctx: ProjectContext, projectId: string, taskId: string, command: TaskCommand): Promise<void> {
    if (!isTaskCommand(command)) throw new ProjectError('INVALID', 'That step is not one this task can take.');
    await this.db.transaction(async (tx) => {
      const project = await this.locked(tx, ctx.companyId, projectId);
      const task = await this.task(tx, ctx.companyId, project.id, taskId);
      const to = applyTaskCommand(task.status, command);
      if (to === null || !projectIsEditable(project.status)) throw new ProjectError('INVALID', 'That task cannot take that step from where it is.');
      await tx
        .update(projectTasks)
        .set({ status: to, version: sql`${projectTasks.version} + 1`, updatedAt: sql`now()` })
        .where(eq(projectTasks.id, task.id));
      await this.note(tx, ctx, project.id, taskEventName(command), task.status, to, { code: task.code });
    });
  }

  private projectInput(raw: ProjectInput): ProjectInput {
    const name = textOf(raw.name);
    const description = raw.description === null ? '' : textOf(raw.description);
    const currency = normalizeCurrency(textOf(raw.currency));
    const budget = textOf(raw.budgetAmount).trim() === '' ? '0' : textOf(raw.budgetAmount);
    const startOn = dayOrNull(raw.startOn);
    const endOn = dayOrNull(raw.endOn);
    const customerId = typeof raw.customerId === 'string' && raw.customerId !== '' ? raw.customerId : null;
    const key = typeof raw.idempotencyKey === 'string' && raw.idempotencyKey !== '' ? raw.idempotencyKey : null;
    if (typeof raw.billable !== 'boolean') refuse('Say whether this work is sold.');
    refuse(checkName(name));
    refuse(checkDescription(description));
    refuse(checkCustomerId(customerId));
    refuse(checkCurrency(currency));
    refuse(checkAmount(budget));
    refuse(checkDates(startOn, endOn));
    if (key !== null && key.length > 80) refuse('That request could not be saved. Try again.');
    return {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      customerId,
      billable: raw.billable,
      currency,
      budgetAmount: storedAmount(budget),
      startOn,
      endOn,
      idempotencyKey: key,
    };
  }

  private taskInput(raw: TaskInput): TaskInput {
    const code = normalizeCode(textOf(raw.code));
    const name = textOf(raw.name);
    const description = raw.description === null ? '' : textOf(raw.description);
    const budget = textOf(raw.budgetAmount).trim() === '' ? '0' : textOf(raw.budgetAmount);
    refuse(checkCode(code));
    refuse(checkName(name, 'task'));
    refuse(checkDescription(description));
    refuse(checkAmount(budget));
    return {
      code,
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      budgetAmount: storedAmount(budget),
    };
  }

  private version(version: number): void {
    if (!Number.isInteger(version) || version < 1) throw new ProjectError('CHANGED', 'This project was changed by someone else. Look again, then try.');
  }

  private sameVersion(current: number, expected: number): void {
    if (current !== expected) throw new ProjectError('CHANGED', 'This project was changed by someone else. Look again, then try.');
  }

  private async customer(db: Reader | Tx, companyId: string, id: string | null): Promise<void> {
    if (id === null) return;
    const [row] = await db.select({ id: customers.id, isActive: customers.isActive }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.id, id)));
    if (row === undefined) throw new ProjectError('NOT_FOUND', 'That customer does not exist.');
    if (!row.isActive) throw new ProjectError('INVALID', 'That customer is not active.');
  }

  private async one(db: Reader, companyId: string, id: string): Promise<ProjectRow | null> {
    const [row] = await db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, id)));
    return row ?? null;
  }

  private async locked(tx: Tx, companyId: string, id: string): Promise<ProjectRow> {
    const [row] = await tx.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, id))).for('update');
    if (row === undefined) throw new ProjectError('NOT_FOUND', 'That project does not exist.');
    return row;
  }

  private async task(tx: Tx, companyId: string, projectId: string, taskId: string) {
    const [row] = await tx
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.companyId, companyId), eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
      .for('update');
    if (row === undefined) throw new ProjectError('NOT_FOUND', 'That task does not exist.');
    return row;
  }

  private async unusedCode(tx: Tx, projectId: string, code: string, exceptId: string | null): Promise<void> {
    const [dup] = await tx.select({ id: projectTasks.id }).from(projectTasks).where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.code, code)));
    if (dup !== undefined && dup.id !== exceptId) throw new ProjectError('DUPLICATE_CODE', 'That task code is already used on this project.');
  }

  private async save(tx: Tx, row: ProjectRow, version: number, patch: Partial<typeof projects.$inferInsert>): Promise<void> {
    const [saved] = await tx
      .update(projects)
      .set({ ...patch, version: sql`${projects.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(projects.id, row.id), eq(projects.companyId, row.companyId), eq(projects.version, version)))
      .returning({ id: projects.id });
    if (saved === undefined) throw new ProjectError('CHANGED', 'This project was changed by someone else. Look again, then try.');
  }

  private async note(tx: Tx, ctx: ProjectContext, projectId: string, event: string, from: string | null, to: string | null, data: Record<string, unknown>): Promise<void> {
    await tx.insert(projectEvents).values({
      projectId,
      event,
      fromStatus: from,
      toStatus: to,
      data,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      origin: ctx.origin,
    });
    await this.decisions.record(
      {
        companyId: ctx.companyId,
        subject: { type: 'project', id: projectId },
        action: `projects.${event}`,
        actor: ctx.actor,
        from,
        to,
        inputs: { origin: ctx.origin },
        outcome: data,
      },
      tx,
    );
  }

  private async taskPage(db: Reader, project: ProjectRow, cursor?: string | null) {
    const after = this.taskCursor(cursor);
    const rows = await db
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, project.id), eq(projectTasks.companyId, project.companyId), after))
      .orderBy(projectTasks.sortOrder, projectTasks.id)
      .limit(TASK_PAGE + 1);
    const page = pageOf(rows, TASK_PAGE, (row) => ({ k: String(row.sortOrder), id: row.id }));
    return {
      tasksNext: page.nextCursor,
      tasks: page.rows.map((row) => this.taskView(project.status, row)),
    };
  }

  private taskCursor(cursor: string | null | undefined) {
    if (!has(cursor)) return undefined;
    const decoded = decodeCursor(cursor);
    if (decoded === null || !UUID.test(decoded.id) || !/^\d+$/.test(decoded.k)) return undefined;
    return sql`(${projectTasks.sortOrder}, ${projectTasks.id}) > (${decoded.k}::int, ${decoded.id}::uuid)`;
  }

  private taskView(projectStatus: ProjectStatus, row: { id: string; code: string; name: string; description: string | null; status: ProjectTaskStatus; budgetAmount: string; version: number }): TaskView {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      budgetAmount: row.budgetAmount,
      version: row.version,
      capabilities: taskCapabilities(projectStatus, row.status),
    };
  }

  private async present(db: Reader, companyId: string, id: string): Promise<ProjectDetail | null> {
    const project = await this.one(db, companyId, id);
    if (project === null) return null;
    const [customer] = project.customerId === null
      ? []
      : await db.select({ name: customers.name }).from(customers).where(and(eq(customers.id, project.customerId), eq(customers.companyId, companyId)));
    const taskPage = await this.taskPage(db, project, null);
    const [sum] = await db
      .select({ total: sql<string>`coalesce(sum(${projectTasks.budgetAmount}), 0)::text` })
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, project.id), eq(projectTasks.companyId, companyId), ne(projectTasks.status, 'cancelled')));
    const events = await db.select().from(projectEvents).where(eq(projectEvents.projectId, project.id)).orderBy(desc(projectEvents.id)).limit(50);
    const actorIds = [...new Set(events.map((event) => event.actorId).filter((actorId): actorId is string => has(actorId) && UUID.test(actorId)))];
    const named = actorIds.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, actorIds));
    const names = new Map(named.map((user) => [user.id, orElse(user.name, user.email)]));
    const taskBudget = normalizeAmount(sum?.total ?? '0') ?? '0.0000';
    return {
      project: {
        id: project.id,
        number: project.number,
        name: project.name,
        description: project.description,
        status: project.status,
        billable: project.billable,
        currency: project.currency,
        budgetAmount: project.budgetAmount,
        startOn: project.startOn,
        endOn: project.endOn,
        customerId: project.customerId,
        customerName: customer?.name ?? null,
        version: project.version,
        taskBudget,
        budgetNote: budgetWarning(project.budgetAmount, [taskBudget]),
        createdAt: project.createdAt.toISOString(),
      },
      tasks: taskPage.tasks,
      tasksNext: taskPage.tasksNext,
      events: events.reverse().map((event) => ({
        id: event.id,
        event: event.event,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        at: event.createdAt.toISOString(),
        when: formatBusinessTime(event.createdAt),
        actor: has(event.actorId) ? (names.get(event.actorId) ?? 'Someone') : 'Someone',
      })),
      capabilities: projectCapabilities(project.status),
    };
  }
}
