import { readFileSync } from 'node:fs';

/** The database name in a connection URL. */
const nameOf = (url: string): string => new URL(url).pathname.replace(/^\//, '');

/** The database the development server uses, from `.env`, if it can be read. */
function developmentDatabase(): string | null {
  try {
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .find((row) => row.startsWith('DATABASE_URL='));
    return line === undefined ? null : nameOf(line.slice('DATABASE_URL='.length).trim());
  } catch {
    return null;
  }
}

/**
 * The database the end-to-end run may change. It must be named with `e2e` and must not be the
 * development database, so a mistaken variable can never point the tests (which seed and write
 * data) at real data.
 */
export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL ?? '';
  if (url === '') {
    throw new Error(
      'Set E2E_DATABASE_URL to an empty database for the end-to-end run, for example ' +
        'postgres://user:pass@127.0.0.1:5434/qsell_e2e (see e2e/README.md).',
    );
  }
  const name = nameOf(url);
  if (!name.includes('e2e')) {
    throw new Error(`E2E_DATABASE_URL must name a database containing "e2e", not "${name}".`);
  }
  if (name === developmentDatabase()) {
    throw new Error('E2E_DATABASE_URL must not be the development database.');
  }
  return url;
}
