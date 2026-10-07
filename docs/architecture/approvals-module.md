# Approvals module — design draft

Goal: every approval rule is **runtime configuration**. An administrator can switch any module,
scenario or condition on or off, and define, add, remove and re-order approvers, without a
deployment, and without ever leaving a document in an unexplained or unreachable state.

Status: decisions taken (§11). A-1 (tables, versioned workflows, switches, approver profiles and
groups, engine) and A-2 (screens: inbox, my requests, designer with simulation, approvers, switches,
monitor) and A-3 (overdue escalation by a five-minute worker job, reroute, "n of" groups, role
approvers) are built. A-4 wires sales orders (staff-placed `sales_order`/`credit_sale` channels), credit notes and stock operations (adjust, write-off, count, bulk). Quotes are wired too (§13). Not wired: customer credit limits, price lists. Reminders need notifications (outbox) and are not built.

## 1. What Business Central does, and what we take from it

BC separates six things. We keep the separation because it is what makes the system configurable.

| BC concept | What it is | Our equivalent |
| --- | --- | --- |
| Workflow Event | "A sales document is released for approval", "A record changed" — a fixed catalogue in code | **Trigger catalogue**, registered in code per module (the only thing a developer adds) |
| Event conditions | Field filters on the record, e.g. Amount > 100 000 | **Condition tree** over a document snapshot, built in the UI |
| Workflow Response | What happens: create approval request, send notification, release, reject, revert to open | **Step actions** (a fixed catalogue too) |
| Workflow (template → copy) | Events and responses chained; templates are read-only, copy to customise; must be disabled to edit | **Workflow definitions**, versioned: draft → enabled → retired |
| Approval User Setup | Per user: approver, amount limits, unlimited flag, substitute | **Approver profile** |
| Workflow User Group | Ordered members with a sequence number | **Approver group** |
| Approval Entry (+ comments, posted/overdue views) | One row per approver per step, with status Created / Open / Approved / Rejected / Canceled | **Approval entries**, plus append-only history |

BC's approver resolution is the part to copy exactly. A step's *approver type* is one of:

1. **Specific approver / user group.** Named people, or a group in sequence order.
2. **Salesperson / purchaser approver.** The approver of the document's owner.
3. **Approver chain by limit.** Start at the requester's approver; if the amount exceeds that
   approver's limit, move to *their* approver, until someone qualifies or has unlimited authority.
4. **First qualified approver.** Skip straight to the first person up the chain whose limit covers it.

BC's behaviours to keep: the document is locked while pending; the requester can cancel; an
approver can approve, reject, or delegate (to their substitute, or the next in chain); overdue
entries escalate; posted history is kept after the document is done.

BC's weaknesses to fix (all from the scale and "always say why" goals):

- Editing a workflow while requests are in flight is blocked, which forces downtime. We version
  instead, and in-flight requests keep the version they started with.
- All entries for a chain are created up front. We create the next approver's entry only when the
  previous one approves (your earlier decision), so reordering later approvers is always safe.
- Conditions are field filters only. We allow and/or groups and comparisons against other fields
  (e.g. `discount% > category.max_discount%`).
- Rejection is a status, with no designed flow. We define it fully (§6).
- No dry run. We simulate any document against any workflow before enabling it (§7).

## 2. The configuration surface

Everything below is edited in the UI, takes effect without deployment, and is recorded in the
decision log with a reason.

### 2.1 Switches (opt in / out)

Three nested switches, each with a reason when changed, each evaluated at request time:

1. **Module** (sales orders, quotes, credit notes, stock adjustments, customers, price lists ...).
2. **Scenario** (a trigger within the module: discount over limit, order value, credit-limit
   release, below floor ...).
3. **Workflow** (one definition for a scenario; several can exist, with priority — first match
   wins, or all matching apply: a per-scenario setting).

Scope can be narrowed to company, branch, or customer group, defaulting to the wider one (same
scope pattern as KRA signing controls). Turning something off never cancels in-flight requests;
they finish under the rules they started with, unless an administrator explicitly reroutes them.

### 2.2 Workflow definition

```
workflow
  code, name, module, trigger, scope (company/branch/...), priority
  match_mode: first_match | all_matches
  status: draft | enabled | retired          -- enable = publish a new immutable version
  conditions: tree   (and / or / not; field, operator, value | other field | parameter)
  steps: ordered list
step
  sequence (1, 2, 3 ...)             -- re-orderable
  approver_rule: user | group | role | owner_approver | chain_by_limit | first_qualified
  approver_ref
  require: any_one | all_of_group | n_of_group
  due_after (hours), on_overdue: remind | escalate_to_next_in_chain | auto_approve | auto_reject
  skip_if: condition                 -- e.g. skip finance step when amount < X
  allow_delegate, allow_self_approval (default false)
  comment_required_on: reject (always) | approve (optional)
```

### 2.3 Approvers

- **Approver profile** (per user): amount limit per document kind, unlimited flag, their own
  approver (the chain link), substitute with date range, notification preference, active flag.
- **Approver group**: ordered members. Members can be added, removed, or re-sequenced at any time.
- **Role approver**: anyone holding a role (uses the existing access-control roles); the entry is
  offered to all holders and the first to act takes it.

Changing any of these never edits an existing entry silently. It affects only entries created
afterwards, because later entries do not exist yet. For entries already open, see §5 (reroute).

## 3. Data model

```
approval_workflows            id, company_id, code, module, trigger, scope_*, priority, match_mode,
                              current_version_id, status
approval_workflow_versions    id, workflow_id, version, definition jsonb (conditions + steps),
                              published_by, published_at, reason          -- immutable
approval_modules / scenarios  per-company switches: enabled, scope, changed_by, reason
approver_profiles             user_id, limits per document kind, unlimited, approver_user_id,
                              substitute_user_id, substitute_from/to, active
approver_groups, _members     group_id, user_id, sequence
approval_requests             id, workflow_version_id, document_kind, document_id, document_hash,
                              requested_by, amount, currency, status
                              (pending | approved | rejected | canceled | expired | superseded),
                              current_step, correlation_id, created_at, closed_at
approval_entries              id, request_id, step_sequence, approver_user_id,
                              status (open | approved | rejected | delegated | canceled | skipped),
                              due_at, acted_at, acted_by, comment, delegated_from_entry_id
approval_history              append-only (trigger-enforced, like the decision log): every
                              transition, who, when, reason code, before/after
```

`approval_requests` has a unique partial index on (document_kind, document_id) where status =
pending: one live request per document, enforced by the database, not by code.
`approval_entries` is indexed on (approver_user_id, status = open) — the approver's inbox is the
hot read. History is partitioned by month.

## 4. Runtime flow

1. A module reaches a trigger point (for example "order submitted"). It calls
   `approvals.evaluate(kind, document)` — one call, the module knows nothing else.
2. The engine loads the enabled workflows for that module/trigger/scope, evaluates conditions on
   a **document snapshot**, and decides: not required, or required by workflow W version V.
3. If required: create the request, store the snapshot hash, lock the document through the
   state machine (pending approval), resolve step 1's approver, create that entry, notify.
4. Approver acts. In one transaction: check the entry is still open, check the actor is the
   approver (or substitute/delegate), write the transition and history, then either create the
   next step's entry (resolving the approver now, with current configuration) or complete.
5. Completion: approved → the state machine releases the document and the originating module
   continues; rejected → §6.
6. Notifications and downstream effects go through the outbox, so a failed email never rolls
   back or blocks an approval.

If **no workflow matches**, no approval is required and that fact is recorded ("no matching
workflow"), so it is explainable later. If the **engine itself fails** (not "no match"), the
document stays unreleased and the error is surfaced; it never silently skips approval.

## 5. Changing things while requests are in flight

| Change | Effect |
| --- | --- |
| Edit a workflow | Publishes version N+1. In-flight requests stay on version N. New requests use N+1. |
| Disable a workflow / module | New requests stop. In-flight requests finish unchanged. |
| Add / remove / re-order approvers in a group or chain | Applies to entries created afterwards (later steps resolve at the time they are reached). |
| Approver left the company / is on leave | Substitute covers automatically by date range; otherwise an administrator **reroutes** the open entry. |
| Reroute an open entry | Admin picks a new approver and a reason; the old entry is closed as *delegated by administrator*, a new one opens, history records both. |
| Change the amount or lines after submission | Document hash no longer matches: the request is **superseded**, approvals are voided, and a new request is evaluated. An approver never approves something that has since changed. |
| Cancel | Only the requester (or an administrator, with a reason) while pending. All open entries become canceled. |

## 6. Rejection flow

Rejecting needs a comment and a reason code. The rest is a configured outcome per workflow, with
a sensible default:

- Request becomes **rejected**; later steps never get entries.
- The document returns to *draft* (default) or to a *rejected* state that blocks it (configurable).
- The requester is notified with the approver, reason and comment.
- The requester may edit and **resubmit**: this starts a new request that links to the rejected
  one, and the approver sees the earlier rejection and comment.
- Everything appears in the document's timeline from the decision log.

## 7. Safety guarantees (what makes it trustworthy at runtime)

- **Validation before enabling:** a workflow cannot be enabled if a step has no approver, a group
  is empty, a chain has no one with enough limit and no unlimited approver at the top, a step
  condition refers to a field that does not exist, or the same person is the only approver *and*
  the usual requester (self-approval).
- **Simulation:** pick a real or sample document and see which workflow matches, which steps
  apply, and who would approve each one, using current configuration. Nothing is written.
- **Segregation of duties:** a requester cannot approve their own request unless the workflow
  explicitly allows it (default: no).
- **Idempotency and concurrency:** each action carries an entry version; two approvers acting at
  once result in one winner and one clear "already decided" message.
- **Stuck-request sweeper:** a background job finds entries past due or whose approver is now
  inactive, and applies the step's overdue rule or alerts an administrator. A request is never
  silently waiting on nobody.
- **Explain everything:** every request stores why it was required (workflow version, which
  conditions matched, with values), and every transition stores who and why.
- **Scale:** only exceptions create requests, so volume is a fraction of order volume. The inbox
  query and the one-live-request-per-document check are index lookups. Condition evaluation is
  in memory on the snapshot; workflow definitions are cached per version (versions are immutable,
  so the cache never goes stale).

## 8. Screens

1. **Approval inbox** (approver): open entries, filter by module/amount/age, approve / reject /
   delegate with comment, document preview, history. Mobile-first and keyboard-accessible.
2. **My requests** (requester): status, who it is waiting on, cancel, resubmit.
3. **Workflow designer** (admin): conditions builder, steps list with drag-to-reorder, approver
   pickers, overdue rules, simulate, publish with reason.
4. **Approvers** (admin): profiles and limits, substitutes, groups with member ordering.
5. **Switches**: module / scenario / scope toggles in one matrix.
6. **Monitor** (admin): pending by approver, overdue, reroute, request timeline.

## 9. Trigger catalogue to start with (developer-registered; workflows over them are runtime)

Sales: discount over threshold, order value over threshold, price below floor (per category),
credit-limit release, delivery/billing block release, quote over value.
Finance: credit note / refund over value, write-off.
Stock: adjustment over size, stock count variance, transfer.
Master data: customer credit-limit change, price list publish.

Adding a trigger later is a small code change in its module; everything about *what happens* is
configuration.

## 10. Phasing

- **A-1:** tables, versioned definitions, switches, approver profiles and groups, engine
  (evaluate, request, act, complete, reject, cancel), history, decision-log integration.
- **A-2:** inbox, requests, designer (conditions, steps, reorder), validation and simulation.
- **A-3:** delegation and substitutes, overdue sweeper, reroute, resubmission links, notifications.
- **A-4:** first modules wired: sales orders (discount, value, credit limit), credit notes, stock
  adjustments.

## 11. Decisions taken

1. **No matching workflow:** the document proceeds, and the evaluation records "no matching workflow".
2. **Several workflows match:** all apply, each as its own request in one submission. The document
   is released when every request is approved. If one is rejected, the others are canceled
   ("sibling rejected") and the document is rejected.
3. **Limits are per document kind** (order, credit note, stock adjustment ...), in the company's
   base currency; the caller supplies the base-currency amount.
4. **Overdue:** escalate to the approver's own approver (the next hop in their chain), with a
   reminder first. Applied by the sweeper (A-3).
5. **Rejected requests must be reopened.** Reopening closes the rejected request and returns the
   document to an editable draft; nothing carries over. Submitting again starts a fresh request
   linked to the rejected one. Submitting a rejected, not-yet-reopened document is refused.

Adjustments made while building A-1: workflow history is the append-only decision log (subject
type `approval_request`) instead of a second history table; `match_mode` is dropped (decision 2);
group steps support "any one" (all open, first wins) and "all" (in sequence order) now, while
"n of m" and role approvers come with A-3.

## 12. How modules take part (A-4)

- **Orders** are created first and held: `orders.approval_status` is `none`, `pending`, `approved`,
  `rejected` or `draft` (reopened). Held orders cannot change fulfilment status (they can be
  cancelled) and cannot have a tax invoice issued. Only staff-placed orders on the sales-order and
  credit channels are checked; shop checkouts and tills never are. An order over the customer's
  credit limit is let through only if a workflow releases it; otherwise it is refused as before.
- **Credit notes and stock changes** do not exist until they happen, so the request is *parked*
  (`approval_parked_actions`: inputs plus a one-line summary for the approver) and carried out in
  the final approver's transaction. If carrying it out fails (stock has since fallen, the invoice is
  already fully credited), the approval is not recorded and the approver sees why. A rejected or
  reopened parked request is simply closed; the requester starts again.
- With no workflow configured, everything runs immediately, exactly as before.

## 13. Quotes

A quote's status keeps its old meaning; `approval_managed_by = 'workflow'` says the engine owns its
approval, otherwise the old margin-floor check does exactly as before.

- **Saving** a quote asks the engine (`sales_quote.submitted`: amount, largest line discount,
  whole-quote discount, gross margin %, below the margin floor, customer). If a workflow applies the quote
  is held as `pending_approval`; if none does but the margin is below the floor, the old rule holds it.
- **While held** the one-click Approve is refused (approval is in the inbox) and the quote cannot be sent.
- **Editing** a waiting quote voids the pending request and asks again. Editing a *refused* quote is
  refused until it is reopened, unless the edit takes it out of every workflow's reach.
- **Released** → `approved`. **Refused** → `draft` with `approval_status = rejected`; **reopened** →
  `approval_status = draft`, then "Send for approval again" (or saving) starts a fresh, linked request.
