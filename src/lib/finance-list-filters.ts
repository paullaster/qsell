/** What a finance list asks the server for, from its filter fields. Pure. */
export function listArgs<S extends string>(status: S | null, q: string, before?: string | null): { status?: S; q?: string; before?: string } {
  const text = q.trim();
  return {
    ...(status === null ? {} : { status }),
    ...(text === '' ? {} : { q: text }),
    ...(before === null || before === undefined ? {} : { before }),
  };
}
