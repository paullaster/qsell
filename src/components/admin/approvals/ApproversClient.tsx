'use client';

import { use, useId, useState } from 'react';
import { type groupsPageAction, type peoplePageAction } from '@/server/kernel/approvals/actions';
import { LoadFailed } from '@/components/ui/screen-kit';
import { ApproversGroups } from './ApproversGroups';
import { ApproversPeople } from './ApproversPeople';
import { PageHeader, buttonClass } from './shared';

interface Props {
  peoplePromise: ReturnType<typeof peoplePageAction>;
  groupsPromise: ReturnType<typeof groupsPageAction>;
}

const TABS = [
  ['people', 'People and limits'],
  ['groups', 'Groups'],
] as const;

export function ApproversClient({ peoplePromise, groupsPromise }: Props) {
  const uid = useId();
  const [tab, setTab] = useState<'people' | 'groups'>('people');
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Approvers">
        Set who is above whom, who covers while someone is away, and how much each person may approve for each kind of document. Changes apply to approvals that have not been asked yet;
        ones already waiting are not touched.
      </PageHeader>
      <div role="tablist" aria-label="Approvers" className="flex gap-2">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            id={`${uid}-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`${uid}-panel-${key}`}
            onClick={() => setTab(key)}
            className={`${buttonClass} ${tab === key ? 'border-indigo-500 bg-indigo-500/10' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`}>
        {tab === 'people' ? <FirstPeople promise={peoplePromise} /> : <FirstGroups promise={groupsPromise} />}
      </div>
    </div>
  );
}

function FirstPeople({ promise }: { promise: Props['peoplePromise'] }) {
  const first = use(promise);
  return first.ok ? <ApproversPeople first={first} /> : <LoadFailed error={first.error} />;
}

function FirstGroups({ promise }: { promise: Props['groupsPromise'] }) {
  const first = use(promise);
  return first.ok ? <ApproversGroups first={first} /> : <LoadFailed error={first.error} />;
}
