/** A value a condition compares: a literal, or another field of the same document. */
export type Operand = string | number | boolean | null | { field: string };

export type Comparison =
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: Operand }
  | { op: 'in' | 'not_in'; field: string; value: (string | number)[] }
  | { op: 'between'; field: string; value: [number, number] }
  | { op: 'contains'; field: string; value: string }
  | { op: 'exists'; field: string; value: boolean };

export type ConditionNode =
  | Comparison
  | { op: 'and' | 'or'; children: ConditionNode[] }
  | { op: 'not'; child: ConditionNode };

export type ApproverRule =
  /** One named user. */
  | { type: 'user'; userId: string }
  /**
   * A group: everyone in sequence order ("all"), all at once with the first to act winning
   * ("any_one"), or all at once until `count` of them have approved ("n_of").
   */
  | { type: 'group'; groupId: string; require: 'all' | 'any_one' | 'n_of'; count?: number }
  /** Everyone who holds a role, all at once; the first to act decides. */
  | { type: 'role'; roleKey: string }
  /** The approver set above whoever submitted the document. */
  | { type: 'owner_approver' }
  /** Climb the requester's chain, one approver per hop, until someone's limit covers the amount. */
  | { type: 'chain_by_limit' }
  /** Climb the chain and ask only the first person whose limit covers the amount. */
  | { type: 'first_qualified' };

export interface StepDefinition {
  sequence: number;
  name: string;
  approver: ApproverRule;
  /** The step is skipped, with a record, when this is true for the document. */
  skipIf?: ConditionNode;
  /** Hours until an open entry is overdue. Overdue entries escalate to the approver's own approver. */
  dueAfterHours?: number;
  allowSelfApproval?: boolean;
}

export interface WorkflowDefinition {
  /** The workflow applies when this is true; no conditions = always. */
  conditions?: ConditionNode;
  steps: StepDefinition[];
}

export interface ConditionTrace { node: string; result: boolean; detail?: string }
