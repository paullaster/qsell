import type { VisitView } from '@/server/domains/van-sales/days';
import { callLink, directionsLink, whatsappLink } from '@/lib/van-sales/contact';

const linkClass = 'inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-sunken px-4 text-sm font-semibold text-fg hover:bg-hover';

/** Call, write on WhatsApp and get directions to a customer, for the links the card has enough to make. */
export function ContactLinks({ visit }: { visit: Pick<VisitView, 'customerName' | 'customerPhone' | 'customerPlace' | 'pin'> }) {
  const call = callLink(visit.customerPhone);
  const chat = whatsappLink(visit.customerPhone);
  const go = directionsLink(visit.pin, visit.customerPlace);
  if (call === null && chat === null && go === null) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label={`Reach ${visit.customerName}`} role="group">
      {call === null ? null : <a className={linkClass} href={call} aria-label={`Call ${visit.customerName}`}>Call</a>}
      {chat === null ? null : <a className={linkClass} href={chat} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${visit.customerName}`}>WhatsApp</a>}
      {go === null ? null : <a className={linkClass} href={go} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${visit.customerName}`}>Directions</a>}
    </div>
  );
}
