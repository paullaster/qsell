/**
 * Remembers which things have been sent to the printer, so one request prints once. It is keyed by the thing itself (the sale the
 * server answered with), not by a component: React may mount the same screen twice (development, a recompile, a re-render of the
 * parent) and each mount would otherwise ask for its own copy. A fresh request is a fresh object, so a reprint still prints.
 */
export function printOnce(): (thing: object, print: () => void) => boolean {
  const done = new WeakSet();
  return (thing, print) => {
    if (done.has(thing)) return false;
    done.add(thing);
    print();
    return true;
  };
}
