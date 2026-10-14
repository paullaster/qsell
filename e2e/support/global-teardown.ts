import { execFileSync } from 'node:child_process';
import { E2E_PORT } from './constants';

/**
 * After the tests: stop whatever still listens on the end-to-end port. Playwright stops the shell
 * that started the dev server but not always the server itself, and a leftover would block the
 * next run (and keep using memory).
 */
export default function globalTeardown(): void {
  try {
    execFileSync('fuser', ['-k', `${String(E2E_PORT)}/tcp`], { stdio: 'ignore' });
  } catch {
    // Nothing was listening, or fuser is not installed: nothing to stop.
  }
}
