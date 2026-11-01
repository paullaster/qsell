'use client';

import { use, useId, useState } from 'react';
import type { geoSettingsPageAction } from '@/server/domains/geo/actions';
import { DEFAULT_USAGE, CHECKED_ON, GEO_PROVIDERS, GEO_PROVIDER_IDS, monthlyVolumes, type GeoProviderId, type UsageProfile } from '@/lib/geo-providers';
import { Field, LoadFailed, Message, PageHeader, cardClass, fieldClass, type Notice } from '@/components/ui/screen-kit';
import { MapProviderCard } from './MapProviderCard';
import { MapSetupPanel, type Saved } from './MapSetupPanel';

type Page = Awaited<ReturnType<typeof geoSettingsPageAction>>;

export function DeliveryMapsClient({ data, canManage }: { data: ReturnType<typeof geoSettingsPageAction>; canManage: Promise<boolean> }) {
  const page = use(data);
  const may = use(canManage);
  return page.ok ? <MapsView page={page} may={may} /> : <LoadFailed error={page.error} />;
}

const number = (text: string, fallback: number): number => {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

function MapsView({ page, may }: { page: Extract<Page, { ok: true }>; may: boolean }) {
  const uid = useId();
  const { metrics, shop } = page.data;
  const [choice, setChoice] = useState<{ driver: GeoProviderId; config: Record<string, unknown>; version: number }>({ driver: page.data.choice.driver, config: page.data.choice.config, version: page.data.choice.version });
  const [setting, setSetting] = useState<GeoProviderId | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [fields, setFields] = useState({ orders: String(shop.ordersLast30Days > 0 ? shop.ordersLast30Days : DEFAULT_USAGE.ordersPerMonth), branches: String(Math.max(shop.branches, 1)), lookups: String(DEFAULT_USAGE.lookupsPerOrder), quotes: String(DEFAULT_USAGE.quotesPerOrder), views: String(DEFAULT_USAGE.mapViewsPerOrder), rate: '' });
  const usage: UsageProfile = {
    ordersPerMonth: number(fields.orders, DEFAULT_USAGE.ordersPerMonth),
    branches: Math.max(1, number(fields.branches, DEFAULT_USAGE.branches)),
    lookupsPerOrder: number(fields.lookups, DEFAULT_USAGE.lookupsPerOrder),
    quotesPerOrder: number(fields.quotes, DEFAULT_USAGE.quotesPerOrder),
    mapViewsPerOrder: number(fields.views, DEFAULT_USAGE.mapViewsPerOrder),
  };
  const rate = number(fields.rate, 0);
  const volumes = monthlyVolumes(usage);
  const set = (key: keyof typeof fields, value: string) => setFields((f) => ({ ...f, [key]: value }));

  const saved = (s: Saved) => {
    setChoice(s);
    setSetting(null);
    setNotice({ kind: 'ok', text: `${GEO_PROVIDERS[s.driver].name} is now the map service.` });
  };

  return (
    <div className="max-w-7xl space-y-5">
      <PageHeader title="Map service" intro="Which map service finds addresses, measures delivery distances and draws the map where customers drop a pin. Compare them on what matters, with your own numbers, then choose. Delivery never stops if a service fails: it falls back to a built-in estimate." />
      <Message notice={notice} />

      <section aria-label="Your volume" className={`${cardClass} space-y-3`}>
        <h2 className="text-sm font-semibold text-fg-strong">Your volume</h2>
        <p className="text-xs text-fg-muted">
          Costs below are worked out from these numbers. Orders are filled in from the last 30 days ({shop.ordersLast30Days.toLocaleString('en-KE')} orders, {shop.branches} {shop.branches === 1 ? 'branch' : 'branches'}); change them to plan for growth.
        </p>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field id={`${uid}-orders`} label="Orders a month">
            <input id={`${uid}-orders`} inputMode="numeric" value={fields.orders} onChange={(e) => set('orders', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-branches`} label="Branches">
            <input id={`${uid}-branches`} inputMode="numeric" value={fields.branches} onChange={(e) => set('branches', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-lookups`} label="Address lookups per order">
            <input id={`${uid}-lookups`} inputMode="decimal" value={fields.lookups} onChange={(e) => set('lookups', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-quotes`} label="Delivery prices per order">
            <input id={`${uid}-quotes`} inputMode="decimal" value={fields.quotes} onChange={(e) => set('quotes', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-views`} label="Map views per order">
            <input id={`${uid}-views`} inputMode="decimal" value={fields.views} onChange={(e) => set('views', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-rate`} label="KES per US$ (optional)" hint="Shows costs in shillings too">
            <input id={`${uid}-rate`} inputMode="decimal" value={fields.rate} onChange={(e) => set('rate', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
        </div>
        <p className="text-xs text-fg-muted" aria-live="polite">
          That is about {volumes.lookups.toLocaleString('en-KE')} address lookups, {volumes.routeElements.toLocaleString('en-KE')} distances and {volumes.mapViews.toLocaleString('en-KE')} map views a month.
        </p>
      </section>

      {setting === null ? null : (
        <MapSetupPanel key={setting} driver={setting} current={setting === choice.driver ? choice.config : {}} version={choice.version} onSaved={saved} onCancel={() => setSetting(null)} />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {GEO_PROVIDER_IDS.map((id) => (
          <MapProviderCard key={id} info={GEO_PROVIDERS[id]} usage={usage} kesPerUsd={rate > 0 ? rate : null} metrics={metrics.find((m) => m.provider === id)} inUse={choice.driver === id} may={may} onChoose={() => setSetting(id)} />
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        Prices and terms were checked on {CHECKED_ON} against each provider’s own pages (linked on each card) and change over time; check them before committing money. Costs are estimates from the numbers above, in US dollars. Reliability figures under “How it has behaved for you” are counted from your own use over the last 30 days. Notes marked “our view” are our judgement, not the provider’s statement.
      </p>
    </div>
  );
}
