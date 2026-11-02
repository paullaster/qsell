import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  COLLECTION_CODE_ALPHABET,
  COLLECTION_CODE_LENGTH,
  generateCollectionCode,
  isWellFormedCollectionCode,
  normalizeCollectionCode,
  showCollectionCode,
} from './collection-code';

describe('the alphabet', () => {
  it('has nothing that looks like something else', () => {
    for (const confusing of ['0', 'O', '1', 'I', 'L']) expect(COLLECTION_CODE_ALPHABET).not.toContain(confusing);
    expect(new Set(COLLECTION_CODE_ALPHABET).size).toBe(COLLECTION_CODE_ALPHABET.length);
  });
});

describe('a new code', () => {
  it('has the right length and only characters of the alphabet', () => {
    for (let n = 0; n < 200; n += 1) {
      const code = generateCollectionCode((count) => new Uint8Array(randomBytes(count)));
      expect(code).toHaveLength(COLLECTION_CODE_LENGTH);
      expect(isWellFormedCollectionCode(code)).toBe(true);
    }
  });

  it('skips bytes that would make some characters likelier than others', () => {
    // 248 is the first byte at or above the fair limit for 31 characters (31 * 8 = 248): it is skipped, the next byte is used.
    const fed = [248, 255, 0, 31, 62, 1, 2, 3, 4, 5, 6, 7];
    let at = 0;
    const code = generateCollectionCode(() => new Uint8Array(fed.slice(at, (at += 12))));
    expect(code).toBe(['A', 'A', 'A', 'B', 'C', 'D'].join(''));
  });

  it('is different each time in practice', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 500; n += 1) seen.add(generateCollectionCode((count) => new Uint8Array(randomBytes(count))));
    expect(seen.size).toBeGreaterThan(495);
  });

  it('keeps asking for bytes until it has enough', () => {
    let calls = 0;
    const code = generateCollectionCode(() => {
      calls += 1;
      return new Uint8Array(calls < 3 ? [255, 255] : [0, 1, 2, 3, 4, 5]);
    });
    expect(code).toBe('ABCDEF');
    expect(calls).toBe(3);
  });
});

describe('what is typed at the counter', () => {
  it('is read in capitals, without spaces or hyphens', () => {
    expect(normalizeCollectionCode(' k7m-4qx ')).toBe('K7M4QX');
    expect(normalizeCollectionCode('k7m 4qx')).toBe('K7M4QX');
    expect(normalizeCollectionCode('k7m–4qx')).toBe('K7M4QX');
  });

  it('is only a code when it has the shape of one', () => {
    expect(isWellFormedCollectionCode('K7M4QX')).toBe(true);
    for (const bad of ['', 'K7M4Q', 'K7M4QXX', 'K7M4Q0', 'K7M4QO', 'K7M4Q1', 'K7M4QI', 'K7M4QL']) expect(isWellFormedCollectionCode(bad), bad).toBe(false);
  });

  it('is shown in two halves', () => {
    expect(showCollectionCode('K7M4QX')).toBe('K7M-4QX');
  });
});
