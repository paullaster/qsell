import { describe, expect, it } from 'vitest';
import { ResultCache } from './cache';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('ResultCache', () => {
  it('computes once and serves the kept value until it expires', async () => {
    let now = 1_000;
    const cache = new ResultCache<string>(15_000, 10, () => now);
    let calls = 0;
    const compute = () => {
      calls += 1;
      return Promise.resolve(`v${String(calls)}`);
    };
    expect(await cache.getOrCompute('k', compute)).toEqual({ value: 'v1', source: 'fresh' });
    expect(await cache.getOrCompute('k', compute)).toEqual({ value: 'v1', source: 'cache' });
    now += 14_999;
    expect((await cache.getOrCompute('k', compute)).source).toBe('cache');
    now += 1;
    expect(await cache.getOrCompute('k', compute)).toEqual({ value: 'v2', source: 'fresh' });
    expect(calls).toBe(2);
  });

  it('keeps different keys apart', async () => {
    const cache = new ResultCache<number>(1_000, 10, () => 0);
    expect((await cache.getOrCompute('a', () => Promise.resolve(1))).value).toBe(1);
    expect((await cache.getOrCompute('b', () => Promise.resolve(2))).value).toBe(2);
    expect(cache.peek('a')).toBe(1);
    expect(cache.peek('b')).toBe(2);
    expect(cache.peek('c')).toBeUndefined();
  });

  it('lets requests that arrive during a read share it', async () => {
    const cache = new ResultCache<string>(1_000, 10, () => 0);
    const d = deferred<string>();
    let calls = 0;
    const first = cache.getOrCompute('k', () => {
      calls += 1;
      return d.promise;
    });
    const second = cache.getOrCompute('k', () => {
      calls += 1;
      return Promise.resolve('other');
    });
    d.resolve('answer');
    expect(await first).toEqual({ value: 'answer', source: 'fresh' });
    expect(await second).toEqual({ value: 'answer', source: 'shared' });
    expect(calls).toBe(1);
  });

  it('never keeps a failure and tells everyone who was waiting', async () => {
    const cache = new ResultCache<string>(1_000, 10, () => 0);
    const d = deferred<string>();
    const first = cache.getOrCompute('k', () => d.promise);
    const second = cache.getOrCompute('k', () => Promise.resolve('unused'));
    d.reject(new Error('database down'));
    await expect(first).rejects.toThrow('database down');
    await expect(second).rejects.toThrow('database down');
    expect(cache.size).toBe(0);
    // The next request tries again instead of replaying the failure.
    expect((await cache.getOrCompute('k', () => Promise.resolve('back'))).value).toBe('back');
  });

  it('is bounded: the oldest entry goes first', async () => {
    const cache = new ResultCache<number>(1_000_000, 2, () => 0);
    await cache.getOrCompute('a', () => Promise.resolve(1));
    await cache.getOrCompute('b', () => Promise.resolve(2));
    await cache.getOrCompute('c', () => Promise.resolve(3));
    expect(cache.size).toBe(2);
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('b')).toBe(2);
    expect(cache.peek('c')).toBe(3);
  });

  it('can be emptied', async () => {
    const cache = new ResultCache<number>(1_000, 5, () => 0);
    await cache.getOrCompute('a', () => Promise.resolve(1));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
