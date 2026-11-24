import { describe, expect, it } from 'vitest';
import { VAN_SALES_DEFAULTS, readSettings, routeModeProblem, vanSalesOn } from './settings';

const good = { ...VAN_SALES_DEFAULTS, vanSell: true, preSell: true };

describe('van sales settings', () => {
  it('start with both modes off, so nothing appears until the company switches them on', () => {
    expect(vanSalesOn(VAN_SALES_DEFAULTS)).toBe(false);
    expect(vanSalesOn({ vanSell: true, preSell: false })).toBe(true);
    expect(vanSalesOn({ vanSell: false, preSell: true })).toBe(true);
  });

  it('are read as sent when every value is allowed', () => {
    expect(readSettings(good)).toEqual({ ok: true, settings: good });
    expect(readSettings({ ...good, shortageApprovalAbove: 250.456 })).toMatchObject({ ok: true, settings: { shortageApprovalAbove: 250.46 } });
  });

  it.each([
    [null, 'could not be read'],
    [{ ...good, vanSell: 'yes' }, 'van selling and pre-selling'],
    [{ ...good, offRoute: 'maybe' }, 'not on the route'],
    [{ ...good, overnightStock: 1 }, 'overnight'],
    [{ ...good, shortage: 'ignore' }, 'missing from a van'],
    [{ ...good, shortageApprovalAbove: -1 }, 'from 0 up'],
    [{ ...good, shortageApprovalAbove: Number.NaN }, 'from 0 up'],
    [{ ...good, position: 'spy' }, 'how far a rep is'],
    [{ ...good, nearMetres: 5 }, 'whole metres from 20 to 5000'],
    [{ ...good, nearMetres: 100.5 }, 'whole metres'],
  ])('refuse %j in words', (raw, words) => {
    const r = readSettings(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });

  it('say which switched-off mode stops a route being in that mode', () => {
    const off = { vanSell: false, preSell: true };
    expect(routeModeProblem(off, 'pre_sell')).toBeNull();
    expect(routeModeProblem(off, 'van_sell')).toBe('Van selling is switched off in Van sales settings.');
    expect(routeModeProblem(off, 'both')).toBe('Van selling is switched off in Van sales settings.');
    expect(routeModeProblem({ vanSell: false, preSell: false }, 'both')).toBe('Van selling and pre-selling are switched off in Van sales settings.');
    expect(routeModeProblem({ vanSell: true, preSell: true }, 'both')).toBeNull();
  });
});
