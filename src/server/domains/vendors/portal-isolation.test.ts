import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vendor isolation guard (design doc §17.1). The vendor must come from the session, never from the request, so this reads
 * the source of every vendor-facing entry point and fails when one could take the vendor, company or user from its caller or
 * skips the portal runner. It is a tripwire for a new action written without the rule; the database tests prove the behaviour.
 */
const DIR = join(process.cwd(), 'src/server/domains/vendors');
/** Actions a person without a session must be able to call; it answers the same for known and unknown addresses. */
const PUBLIC_ACTIONS = new Set(['registerVendorAction']);
const FORBIDDEN_PARAMS = /\b(vendorId|companyId|userId|actor|portalRole)\b/;

const portalFiles = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && readFileSync(join(DIR, f), 'utf8').includes("from './portal-runner'"));

/** Exported async functions with their parameter list and body, found without a TypeScript API (TS 7 has none). */
function exported(source: string): { name: string; params: string; body: string }[] {
  const out: { name: string; params: string; body: string }[] = [];
  const re = /export async function (\w+)\(([^)]*)\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ name: m[1] ?? '', params: m[2] ?? '', body: source.slice(re.lastIndex, i) });
  }
  return out;
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('vendor portal entry points', () => {
  it('finds the portal action files', () => {
    expect(portalFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of portalFiles) {
    const fns = exported(readFileSync(join(DIR, file), 'utf8'));
    it(`${file}: every exported action runs through the portal runner and takes no vendor, company or user from its caller`, () => {
      for (const fn of fns.filter((f) => !PUBLIC_ACTIONS.has(f.name))) {
        expect(fn.body, `${fn.name} must call portal(`).toMatch(/\bportal(<[^>]*>)?\(/);
        expect(fn.params, `${fn.name} must not take the vendor, company or user as an argument`).not.toMatch(FORBIDDEN_PARAMS);
      }
    });
  }

  it('every upload and download route under /api/vendor uses the portal runner or the portal session', () => {
    const files = routeFiles(join(process.cwd(), 'app/api/vendor'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).toMatch(/portal\(|requirePortalVendor\(|vendorSession\(/);
    }
  });
});
