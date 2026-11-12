/* Sends the rider's saved door work from the service worker, so it goes as soon as the phone has signal again even when the rider has
 * closed the app. It follows the same rules as the app's own sender (src/components/rider/send-queue.ts and src/lib/rider-queue.ts): the
 * oldest due item first, the stops of a run before its finish, a wait that doubles after each failed try, a refusal kept with its
 * reason, and "not signed in" leaving the item alone. A test holds the two to the same answers. Every item carries the key of its try,
 * so an item the app and this worker both send is one try on the shop. Loaded by rider-sw.js; also usable from tests. */
(function (root) {
  var BASE_WAIT_MS = 5000;
  var MAX_WAIT_MS = 5 * 60000;

  function verdictOf(reply) {
    if (reply.ok === true) return 'done';
    if (reply.forbidden === true) return 'sign_in';
    if (reply.code === 'NOT_FOUND' || reply.code === 'NOT_ALLOWED' || reply.code === 'BAD_INPUT' || reply.code === 'CONFLICT') return 'rejected';
    return 'retry';
  }

  function waitAfter(tries) {
    return Math.min(MAX_WAIT_MS, BASE_WAIT_MS * Math.pow(2, Math.max(0, tries - 1)));
  }

  function byAge(a, b) {
    var c = a.createdAt.localeCompare(b.createdAt);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  }

  /** The next item to send for this rider: the oldest whose wait is over; a finish only when its run has no stop waiting. */
  function nextToSend(items, riderId, now) {
    var waiting = items.filter(function (i) { return i.riderId === riderId && i.state === 'waiting'; }).sort(byAge);
    var due = waiting.filter(function (i) { return i.nextAt <= now; });
    var stops = due.filter(function (i) { return i.kind !== 'finish'; });
    if (stops.length > 0) return stops[0];
    var finish = due.find(function (i) { return !waiting.some(function (w) { return w.kind !== 'finish' && w.runId === i.runId; }); });
    return finish === undefined ? null : finish;
  }

  function riderIds(items) {
    var seen = [];
    items.forEach(function (i) { if (i.state === 'waiting' && seen.indexOf(i.riderId) < 0) seen.push(i.riderId); });
    return seen;
  }

  /**
   * deps: { items(): Promise<item[]>, get(id), put(item), remove(id), post(path, body): Promise<json>, upload(blob): Promise<{ok, photoId?, error?, network}>, now(): number }.
   * Answers { sent, retry } where retry means something could not be sent for want of signal or a shop fault, so the browser should try again later.
   */
  async function sendWaiting(deps) {
    var result = { sent: 0, retry: false };
    var signedOut = [];
    async function later(item, patch) {
      var current = await deps.get(item.id);
      if (current === undefined || current === null) return; // the app sent it meanwhile
      var tries = current.tries + 1;
      await deps.put(Object.assign({}, current, patch, { tries: tries, nextAt: deps.now() + waitAfter(tries) }));
    }
    for (;;) {
      var all = await deps.items();
      var item = null;
      var ids = riderIds(all).filter(function (id) { return signedOut.indexOf(id) < 0; });
      for (var k = 0; k < ids.length && item === null; k += 1) item = nextToSend(all, ids[k], deps.now());
      if (item === null) break;
      var photoId = item.photoId;
      if (item.photo !== null && photoId === null) {
        var up = await deps.upload(item.photo);
        if (up.ok === true) {
          photoId = up.photoId;
          await deps.put(Object.assign({}, item, { photoId: photoId }));
        } else {
          await later(item, { message: up.error });
          result.retry = true;
          break;
        }
      }
      var reply;
      try {
        reply = await deps.post('/api/rider/door-sync', { id: item.id, riderId: item.riderId, kind: item.kind, runId: item.runId, deliveryId: item.deliveryId, payload: item.payload, photoId: photoId });
      } catch (e) {
        await later(item, {});
        result.retry = true;
        break;
      }
      var verdict = verdictOf(reply);
      if (verdict === 'done') {
        await deps.remove(item.id);
        result.sent += 1;
      } else if (verdict === 'rejected') {
        await deps.put(Object.assign({}, item, { state: 'rejected', message: reply.ok === true ? null : reply.error, photo: null }));
      } else if (verdict === 'sign_in') {
        signedOut.push(item.riderId);
      } else {
        await later(item, {});
        result.retry = true;
        break;
      }
    }
    return result;
  }

  var api = { verdictOf: verdictOf, waitAfter: waitAfter, nextToSend: nextToSend, sendWaiting: sendWaiting };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RiderSync = api;
})(typeof self !== 'undefined' ? self : this);
