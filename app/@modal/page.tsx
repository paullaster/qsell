/**
 * Renders nothing for "/". Without it, a client-side navigation from an
 * intercepted modal (e.g. the sign-in popup) back to "/" leaves the modal on
 * screen, because a parallel slot keeps its last state when no route matches.
 */
export default function ModalRoot() {
  return null;
}
