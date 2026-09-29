/**
 * Renders nothing for every other path, so navigating anywhere that isn't an
 * intercepted modal route closes the open modal (see app/@modal/page.tsx).
 */
export default function ModalCatchAll() {
  return null;
}
