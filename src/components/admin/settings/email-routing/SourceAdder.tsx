'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { LabelledSource } from '@/server/domains/email-routing/email-route-service';
import type { RouteSource, SourceKind } from '@/server/domains/email-routing/email-routes';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { buttonClass, fieldClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

const sourceOf = (source: RouteSource, label: string): LabelledSource => ({ source, label, address: null, problem: null });

const NEEDS_VALUE: SourceKind[] = ['staff', 'channel', 'address'];

/** Adds one person to a list: first where to find the address, then which one when it needs choosing. */
export function SourceAdder({ idBase, title, onAdd, lists = { kinds: 'email-routing-source-kinds', staff: 'email-routing-staff', channels: 'email-routing-channels' } }: { idBase: string; title: string; onAdd: (next: LabelledSource) => void; lists?: { kinds: string; staff: string; channels: string } }) {
  const [kind, setKind] = useState<Choice | null>(null);
  const [typed, setTyped] = useState('');
  const [picker, setPicker] = useState(0);
  const chosen = kind?.id as SourceKind | undefined;
  const done = () => {
    setKind(null);
    setTyped('');
    setPicker((n) => n + 1);
  };
  const pickedKind = (c: Choice | null) => {
    setKind(c);
    const k = c?.id as SourceKind | undefined;
    if (c !== null && k !== undefined && !NEEDS_VALUE.includes(k)) {
      onAdd(sourceOf({ kind: k } as RouteSource, c.label));
      done();
    }
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2" key={picker}>
      <ChoicePicker label={`Add to ${title}`} source={lists.kinds} clearable={false} choice={kind} onChoice={pickedKind} placeholder="Where to find the address…" />
      {chosen === 'staff' ? (
        <ChoicePicker label="Staff member" source={lists.staff} choice={null} onChoice={(c) => { if (c !== null) { onAdd(sourceOf({ kind: 'staff', userId: c.id }, c.label)); done(); } }} placeholder="Search staff…" />
      ) : null}
      {chosen === 'channel' ? (
        <ChoicePicker label="Support channel" source={lists.channels} choice={null} onChoice={(c) => { if (c !== null) { onAdd(sourceOf({ kind: 'channel', channelId: c.id }, c.label)); done(); } }} placeholder="Choose an email channel…" />
      ) : null}
      {chosen === 'address' ? (
        <div className="flex gap-2">
          <input id={`${idBase}-address`} aria-label="Email address" type="email" className={fieldClass} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="name@company.co.ke" />
          <button type="button" className={buttonClass} disabled={typed.trim() === ''} onClick={() => { onAdd(sourceOf({ kind: 'address', address: typed.trim() }, typed.trim())); done(); }}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add</button>
        </div>
      ) : null}
    </div>
  );
}
