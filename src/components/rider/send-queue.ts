import { deliverStopAction, failStopAction, finishRunAction } from '@/server/domains/delivery/rider-app-actions';
import { nextToSend, verdictOf, waitAfter, type QueuedItem, type Reply } from '@/lib/rider-queue';
import { allItems, putItem, removeItem } from './door-queue';
import { uploadProofPhoto } from './door-support';

export interface Sent {
  /** How many items the shop took (or had already taken). */
  sent: number;
  /** The rider is no longer signed in, so nothing more can be sent until they sign in again. */
  signIn: boolean;
}

let sending = false;

/** What the action is given: the payload as it was at the door, the key of the try, and the photo's id once it has one. */
function callFor(item: QueuedItem, photoId: string | null): Promise<Reply> {
  const base = { ...item.payload, runId: item.runId, deliveryId: item.deliveryId, clientKey: item.id, photoId };
  if (item.kind === 'deliver') return deliverStopAction(base);
  if (item.kind === 'fail') return failStopAction(base);
  return finishRunAction(item.runId);
}

const later = async (item: QueuedItem, now: number, patch: Partial<QueuedItem> = {}): Promise<void> => {
  const tries = item.tries + 1;
  await putItem({ ...item, ...patch, tries, nextAt: now + waitAfter(tries) });
};

/**
 * Sends this rider's waiting items one at a time, oldest first (the stops of a run before its finish). An item the phone cannot send
 * (no signal, the server fell over) waits longer each time and sending stops there, so a dead connection is not hammered; one the
 * shop refuses is kept, with its reason, for the rider to read. Because every item carries the key of its try, an item that was
 * received but whose answer was lost is answered as before, never done twice. Only one send runs at a time in a tab.
 */
export async function sendQueue(riderId: string, now: () => number = Date.now, ignoreWait = false): Promise<Sent> {
  const result: Sent = { sent: 0, signIn: false };
  if (sending) return result;
  sending = true;
  try {
    for (;;) {
      const item = nextToSend(await allItems(), riderId, ignoreWait ? Number.MAX_SAFE_INTEGER : now());
      if (item === null) break;
      let photoId = item.photoId;
      if (item.photo !== null && photoId === null) {
        const up = await uploadProofPhoto(new File([item.photo], 'door.jpg', { type: item.photo.type === '' ? 'image/jpeg' : item.photo.type }));
        if (up.ok) {
          photoId = up.photoId;
          await putItem({ ...item, photoId });
        } else {
          await later(item, now(), { message: up.error });
          break;
        }
      }
      let reply: Reply;
      try {
        reply = await callFor(item, photoId);
      } catch {
        await later(item, now());
        break;
      }
      const verdict = verdictOf(reply);
      if (verdict === 'done') {
        await removeItem(item.id);
        result.sent += 1;
      } else if (verdict === 'rejected') {
        await putItem({ ...item, state: 'rejected', message: reply.ok ? null : reply.error, photo: null });
      } else if (verdict === 'sign_in') {
        result.signIn = true;
        break;
      } else {
        await later(item, now());
        break;
      }
    }
  } finally {
    sending = false;
  }
  return result;
}
