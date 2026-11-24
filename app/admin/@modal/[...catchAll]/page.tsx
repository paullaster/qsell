/**
 * Any admin address the modal slot has no screen for shows nothing. Without it, a link followed from inside an opened order (to its
 * delivery, say) leaves the order's window over the new screen, because a slot keeps what it showed when the next address does not match it.
 */
export default function AdminModalCatchAll() {
  return null;
}
