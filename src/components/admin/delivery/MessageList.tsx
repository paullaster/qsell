'use client';

import { useWhen } from '@/components/business-time';
import { Chip } from '@/components/ui/screen-kit';
import { KIND_WORDS, isMessageKind } from '@/lib/delivery-messages';
import type { MessageView } from '@/server/domains/delivery/messages';

const TONE = { sent: 'green', failed: 'red', skipped: 'gray', queued: 'gray' } as const;
const WORDS = { sent: 'Sent', failed: 'Not sent yet', skipped: 'Not sent', queued: 'Waiting to send' } as const;

/** What the customer was written, one line each: the message, whether it left, where it went (hidden but for its ends) and when. */
export function MessageList({ messages, label }: { messages: MessageView[]; label: string }) {
  const when = useWhen();
  return (
    <ul className="space-y-1.5" aria-label={label}>
      {messages.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-semibold text-fg-strong">{isMessageKind(m.kind) ? KIND_WORDS[m.kind] : m.kind}{m.channel === 'sms' ? ' (text message)' : ''}</span>
          <Chip tone={TONE[m.status]}>{WORDS[m.status]}</Chip>
          <span className="text-xs text-fg-muted">
            {m.recipient === '' ? '' : `to ${m.recipient} · `}
            {when(m.sentAt ?? m.createdAt)}
          </span>
          {m.note === null ? null : <span className="text-xs text-fg-muted">{m.note}</span>}
        </li>
      ))}
    </ul>
  );
}
