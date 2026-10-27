import { describe, expect, it } from 'vitest';
import { getAdminNav } from '@/config/admin-nav';
import { PLATFORM_MODULES, platformKeywords } from './platform-modules';

/** A module is not finished until it is described for search here (docs/PROJECT_RULES.md, section 10). */
describe('platform SEO registry', () => {
  const nav = getAdminNav();

  it('has an entry for every module in the admin navigation', () => {
    const missing = nav.filter((item) => !PLATFORM_MODULES.some((module) => module.navId === item.id)).map((item) => item.id);
    expect(missing, `Register these modules in src/config/seo/platform-modules.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('names every sub-module of every module', () => {
    const missing: string[] = [];
    for (const item of nav) {
      const entry = PLATFORM_MODULES.find((module) => module.navId === item.id);
      for (const sub of item.subLinks ?? []) {
        if (entry?.subModules.includes(sub.title) !== true) missing.push(`${item.id} > ${sub.title}`);
      }
    }
    expect(missing, `Add these sub-modules to their entry's subModules: ${missing.join('; ')}`).toEqual([]);
  });

  it('describes every module in words people search for', () => {
    for (const entry of PLATFORM_MODULES) {
      expect(entry.name.length, entry.navId).toBeGreaterThan(5);
      expect(entry.summary.length, entry.navId).toBeGreaterThan(30);
      expect(entry.features.length, entry.navId).toBeGreaterThanOrEqual(2);
      expect(entry.keywords.length, entry.navId).toBeGreaterThanOrEqual(3);
      expect(nav.some((item) => item.id === entry.navId), `${entry.navId} is not a navigation module`).toBe(true);
    }
  });

  it('repeats no keyword', () => {
    const all = PLATFORM_MODULES.flatMap((entry) => entry.keywords.map((word) => word.toLowerCase()));
    expect(all.filter((word, index) => all.indexOf(word) !== index)).toEqual([]);
    expect(platformKeywords().length).toBeGreaterThan(30);
  });
});
