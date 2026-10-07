import type { StepDefinition } from './types';

/** What the resolver needs to know about people; the service reads it from the database. */
export interface ApproverDirectory {
  /** The next link up the chain, or null at the top. */
  approverOf(userId: string): string | null;
  /** Can this person approve this amount of this kind of document? */
  qualifies(userId: string, kind: string, amount: number): boolean;
  /** Can this person act at all (active, exists)? */
  isEligible(userId: string): boolean;
  /** Group members in sequence order. */
  groupMembers(groupId: string): string[];
  /** Everyone who holds a role. */
  roleMembers(roleKey: string): string[];
}

export interface StepEntryRecord {
  position: number;
  approverUserId: string;
  /** The person originally meant, when a substitute covered. */
  onBehalfOfUserId?: string | null;
  status: 'open' | 'approved' | 'rejected' | 'canceled';
}

export interface ResolveInput {
  step: StepDefinition;
  directory: ApproverDirectory;
  requesterId: string;
  documentKind: string;
  amount: number;
  /** Entries already created for this step, oldest first. */
  entries: StepEntryRecord[];
}

export type Offer =
  { done: true } | { done: false; offers: Array<{ userId: string; position: number }> };

export class NoEligibleApprover extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoEligibleApprover';
  }
}

/**
 * Who gets the next entry of a step, or that the step is complete. Pure: the same inputs always
 * give the same answer, which is what makes approvals explainable and testable.
 */
export function nextOffers(input: ResolveInput): Offer {
  const { step, directory, requesterId, documentKind, amount, entries } = input;
  const allowSelf = step.allowSelfApproval === true;
  const ok = (id: string) => directory.isEligible(id) && (allowSelf || id !== requesterId);
  const rule = step.approver;
  // The person each entry was meant for (a substitute may have acted for them).
  const intended = (e: StepEntryRecord) => e.onBehalfOfUserId ?? e.approverUserId;
  const last = entries.at(-1);

  switch (rule.type) {
    case 'user': {
      if (entries.length > 0) return { done: true };
      if (!ok(rule.userId)) {
        throw new NoEligibleApprover(
          `Step "${step.name}": the named approver cannot approve this document${
            rule.userId === requesterId ? ' (a requester cannot approve their own request)' : ''
          }.`,
        );
      }
      return { done: false, offers: [{ userId: rule.userId, position: 0 }] };
    }

    case 'role': {
      if (entries.length > 0) return { done: true };
      const eligible = directory.roleMembers(rule.roleKey).filter(ok);
      if (eligible.length === 0) {
        throw new NoEligibleApprover(
          `Step "${step.name}": nobody holding the role can approve this document.`,
        );
      }
      return { done: false, offers: eligible.map((userId, i) => ({ userId, position: i })) };
    }

    case 'group': {
      const members = directory.groupMembers(rule.groupId);
      if (rule.require === 'n_of') {
        const count = rule.count ?? 1;
        const approved = entries.filter((e) => e.status === 'approved').length;
        const open = entries.filter((e) => e.status === 'open').length;
        if (entries.length === 0) {
          const eligible = members.filter(ok);
          if (eligible.length < count) {
            throw new NoEligibleApprover(
              `Step "${step.name}": ${count} approvals are needed but only ${eligible.length} group member${eligible.length === 1 ? ' is' : 's are'} able to approve.`,
            );
          }
          return { done: false, offers: eligible.map((userId, i) => ({ userId, position: i })) };
        }
        if (approved >= count) return { done: true };
        // Still waiting on the people already asked.
        if (approved + open >= count) return { done: false, offers: [] };
        throw new NoEligibleApprover(
          `Step "${step.name}": ${count} approvals can no longer be reached.`,
        );
      }
      if (rule.require === 'any_one') {
        if (entries.length > 0) return { done: true };
        const eligible = members.filter(ok);
        if (eligible.length === 0) {
          throw new NoEligibleApprover(
            `Step "${step.name}": nobody in the approver group can approve this document.`,
          );
        }
        return { done: false, offers: eligible.map((userId, i) => ({ userId, position: i })) };
      }
      // "all": each member in order, skipping people who cannot act (and the requester's own turn).
      const handled = new Set(entries.map(intended));
      const remaining = members.filter((m) => !handled.has(m)).filter(ok);
      if (remaining.length === 0) {
        if (entries.length === 0) {
          throw new NoEligibleApprover(
            `Step "${step.name}": nobody in the approver group can approve this document.`,
          );
        }
        return { done: true };
      }
      return { done: false, offers: [{ userId: remaining[0]!, position: entries.length }] };
    }

    case 'owner_approver': {
      if (entries.length > 0) return { done: true };
      const target = directory.approverOf(requesterId);
      if (!target || !ok(target)) {
        throw new NoEligibleApprover(`Step "${step.name}": the requester has no approver set up.`);
      }
      return { done: false, offers: [{ userId: target, position: 0 }] };
    }

    case 'chain_by_limit':
    case 'first_qualified': {
      const visited = new Set<string>([requesterId, ...entries.map(intended)]);
      // Where to start climbing: above the last person asked, or above the requester.
      let from = last ? intended(last) : requesterId;
      if (last) {
        visited.add(from);
        // A chain is finished once the person asked can cover the amount.
        if (rule.type === 'first_qualified') return { done: true };
        if (directory.qualifies(intended(last), documentKind, amount)) return { done: true };
      }
      for (let hops = 0; hops < 100; hops++) {
        const next = directory.approverOf(from);
        if (!next || visited.has(next)) {
          throw new NoEligibleApprover(
            `Step "${step.name}": nobody up the approval chain can approve ${amount.toLocaleString('en-KE')} for this document.`,
          );
        }
        visited.add(next);
        from = next;
        if (!ok(next)) continue;
        if (rule.type === 'first_qualified' && !directory.qualifies(next, documentKind, amount))
          continue;
        return { done: false, offers: [{ userId: next, position: entries.length }] };
      }
      throw new NoEligibleApprover(`Step "${step.name}": the approval chain is too long or loops.`);
    }
  }
}
