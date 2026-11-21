import '@testing-library/jest-dom/vitest';
import { afterAll, beforeAll, vi } from 'vitest';
import postgres from 'postgres';

// jsdom has no layout, so it lacks a few browser features that components use. These stand-ins do
// nothing; a test that cares replaces them. (Node-only test files skip this.)
if (typeof window !== 'undefined') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }),
  });
  class FakeIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds = [];
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: FakeIntersectionObserver,
  });
}

// Test files share one database and run one after another. "The company" is the active one touched last, and some files add a company
// of their own, which then stays the newest: the next file would be handed that stranger (its order numbers start again at 1, and an
// order number is unique across the database). So every file starts and ends with the first company made as the newest, and a file that
// wants a company of its own still makes it after that.
const testDatabase = process.env.TEST_DATABASE_URL;
if (typeof window === 'undefined' && testDatabase !== undefined && testDatabase !== '') {
  const putFirstCompanyForward = async (): Promise<void> => {
    const sql = postgres(testDatabase, { max: 1, onnotice: () => undefined });
    try {
      await sql`UPDATE company_settings SET updated_at = clock_timestamp() WHERE id = (SELECT id FROM company_settings WHERE is_active ORDER BY created_at, id LIMIT 1)`;
    } catch {
      // No such table yet (a unit test run against an empty database): nothing to put forward.
    } finally {
      await sql.end({ timeout: 2 });
    }
  };
  beforeAll(putFirstCompanyForward);
  afterAll(putFirstCompanyForward);
}
