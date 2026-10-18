import { describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => async (file: string) => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(`${process.cwd()}/src/server/domains/${file}.ts`, 'utf8');
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]);
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  const actions: Record<string, () => Promise<never>> = {};
  for (const name of names) actions[name] = never;
  return actions;
});

vi.mock('@/server/domains/projects/actions', () => stub('projects/actions'));

const pending = <T,>() => new Promise<T>(() => undefined);

const pages: [string, () => Promise<{ default: (props: never) => unknown }>, Record<string, unknown>][] = [
  ['projects', () => import('../../../../app/admin/projects/page'), {}],
  ['new project', () => import('../../../../app/admin/projects/new/page'), {}],
  ['project', () => import('../../../../app/admin/projects/[id]/page'), { params: pending() }],
];

describe('project pages do not wait for their data', () => {
  it.each(pages)('%s returns its frame immediately', async (_name, load, props) => {
    const page = (await load()).default;
    const out = page(props as never);
    expect(out instanceof Promise).toBe(false);
    expect(out).toBeTruthy();
  });
});
