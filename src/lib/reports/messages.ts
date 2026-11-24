import { EN, type MessageId } from '@/lib/reports/messages/en';

export type { MessageId };

/** The names inside `{braces}` of a template, as a union. */
type SlotNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | SlotNames<Rest>
  : never;

type SlotsOf<K extends MessageId> = SlotNames<(typeof EN)[K]>;

type SlotArgs<K extends MessageId> = [SlotsOf<K>] extends [never]
  ? []
  : [slots: Record<SlotsOf<K>, string | number>];

const SLOT = /\{([a-z_]+)\}/g;

/** The slot names a template asks for, in order of first appearance (used by the tests and by other languages). */
export function slotsOf(template: string): string[] {
  const seen: string[] = [];
  for (const match of template.matchAll(SLOT)) {
    const name = match[1];
    if (name !== undefined && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * The words for an id, with its slots filled. A slot the caller did not give stays visible as `{name}` so a
 * missing value is seen in review instead of silently disappearing; the types stop it at compile time.
 */
export function t<K extends MessageId>(id: K, ...args: SlotArgs<K>): string {
  const template: string = EN[id];
  const given = (args[0] ?? {}) as Record<string, string | number>;
  return template.replace(SLOT, (whole, name: string) => {
    const value = given[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * The words for an id that is not known at compile time (a title or question read from the registry). A message that
 * has slots comes back with them still in `{braces}`; report titles, questions and labels have none.
 */
export function plainText(id: MessageId): string {
  return EN[id];
}

/** Every id, for tests and for tools that list the catalogue. */
export const MESSAGE_IDS = Object.keys(EN) as MessageId[];
