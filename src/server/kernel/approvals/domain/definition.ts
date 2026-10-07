import { fieldsUsed } from './conditions';
import { triggerByCode } from './triggers';
import type { ConditionNode, WorkflowDefinition } from './types';

export interface DefinitionIssue {
  path: string;
  message: string;
}

const MAX_DEPTH = 8;

function depth(node: ConditionNode | undefined): number {
  if (!node) return 0;
  if (node.op === 'and' || node.op === 'or') return 1 + Math.max(0, ...node.children.map(depth));
  if (node.op === 'not') return 1 + depth(node.child);
  return 1;
}

/**
 * Checks that a definition is complete and refers only to things that exist. A workflow is only
 * published when this returns nothing; the checks that need the database (users, groups, chains)
 * are done by the service.
 */
export function validateDefinition(trigger: string, def: WorkflowDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const t = triggerByCode(trigger);
  if (!t) return [{ path: 'trigger', message: `Unknown trigger "${trigger}".` }];

  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    issues.push({ path: 'steps', message: 'Add at least one approval step.' });
    return issues;
  }

  const known = new Set(t.fields.map((f) => f.path));
  const checkFields = (node: ConditionNode | undefined, where: string) => {
    if (depth(node) > MAX_DEPTH)
      issues.push({ path: where, message: 'Conditions are nested too deeply.' });
    for (const f of fieldsUsed(node)) {
      if (!known.has(f))
        issues.push({ path: where, message: `"${f}" is not a field of ${t.label}.` });
    }
  };
  checkFields(def.conditions, 'conditions');

  const seen = new Set<number>();
  def.steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    if (!Number.isInteger(step.sequence) || step.sequence < 1) {
      issues.push({ path: at, message: 'The step order must be a whole number from 1.' });
    } else if (seen.has(step.sequence)) {
      issues.push({ path: at, message: `Two steps share the order ${step.sequence}.` });
    }
    seen.add(step.sequence);
    if (!step.name?.trim()) issues.push({ path: at, message: 'Name the step.' });
    if (step.dueAfterHours !== undefined && !(step.dueAfterHours > 0)) {
      issues.push({ path: at, message: 'The due time must be above zero hours.' });
    }
    const a = step.approver;
    if (!a) issues.push({ path: at, message: 'Choose who approves this step.' });
    else if (a.type === 'user' && !a.userId)
      issues.push({ path: at, message: 'Choose the approving user.' });
    else if (a.type === 'group' && !a.groupId)
      issues.push({ path: at, message: 'Choose the approver group.' });
    else if (
      a.type === 'group' &&
      a.require === 'n_of' &&
      !(Number.isInteger(a.count) && a.count! >= 1)
    )
      issues.push({ path: at, message: 'Say how many members must approve (at least 1).' });
    else if (a.type === 'role' && !a.roleKey)
      issues.push({ path: at, message: 'Choose the role.' });
    else if (
      !['user', 'group', 'role', 'owner_approver', 'chain_by_limit', 'first_qualified'].includes(
        a.type,
      )
    ) {
      issues.push({
        path: at,
        message: `Unknown approver type "${(a as { type: string }).type}".`,
      });
    }
    checkFields(step.skipIf, `${at}.skipIf`);
  });
  return issues;
}

export const sortedSteps = (def: WorkflowDefinition) =>
  [...def.steps].sort((a, b) => a.sequence - b.sequence);
