/**
 * What an administrator needs to know to choose a map service: what each costs for their own volume, how it behaves, and what
 * its terms demand. Pure data and arithmetic, so the screen and the tests read the same numbers.
 *
 * Prices and terms are those published by each provider on `CHECKED_ON`, with the page they came from. They change; the screen
 * says when they were checked and links the source. Where a provider's price could not be confirmed from its own page, no
 * number is shown (`unknown`) rather than a guess. Judgements that are ours and not the provider's are marked as such.
 */

export const CHECKED_ON = '2026-11-01';

export const GEO_PROVIDER_IDS = ['builtin', 'osm', 'google', 'mapbox'] as const;
export type GeoProviderId = (typeof GEO_PROVIDER_IDS)[number];
export const isGeoProviderId = (value: unknown): value is GeoProviderId => typeof value === 'string' && (GEO_PROVIDER_IDS as readonly string[]).includes(value);

/** How a business uses maps, in the numbers that drive the bill. */
export interface UsageProfile {
  ordersPerMonth: number;
  /** Branches that are ranked for each delivery quote. */
  branches: number;
  /** Address searches and pin-to-address lookups for each order. */
  lookupsPerOrder: number;
  /** Times a shopper's delivery is priced for each order (changing the pin or address prices it again). */
  quotesPerOrder: number;
  /** Times the map picker is opened for each order. */
  mapViewsPerOrder: number;
}

export const DEFAULT_USAGE: UsageProfile = { ordersPerMonth: 1000, branches: 3, lookupsPerOrder: 2, quotesPerOrder: 2, mapViewsPerOrder: 1 };

export interface MonthlyVolumes {
  /** Geocoding calls: address searches and pin lookups. */
  lookups: number;
  /** Distances asked for: each quote ranks the branches and then measures the chosen leg (and the way back for a round trip). */
  routeElements: number;
  /** Requests to a routing server: one to rank the branches and one to measure the chosen leg, for each quote. */
  routeRequests: number;
  mapViews: number;
}

export function monthlyVolumes(u: UsageProfile): MonthlyVolumes {
  const orders = Math.max(0, u.ordersPerMonth);
  return {
    lookups: Math.round(orders * Math.max(0, u.lookupsPerOrder)),
    routeElements: Math.round(orders * Math.max(0, u.quotesPerOrder) * (Math.max(1, u.branches) + 2)),
    routeRequests: Math.round(orders * Math.max(0, u.quotesPerOrder) * 2),
    mapViews: Math.round(orders * Math.max(0, u.mapViewsPerOrder)),
  };
}

/** A price that grows cheaper by volume: the first `free` units cost nothing; each band is charged at its own rate per 1,000. */
export interface Tiered {
  free: number;
  /** Upper edge of each band (units a month, counted from zero) and its price per 1,000 units, in US dollars. The last band has no edge. */
  bands: readonly { upTo: number | null; perThousandUsd: number }[];
}

export function tieredCostUsd(units: number, price: Tiered): number {
  let cost = 0;
  let from = price.free;
  for (const band of price.bands) {
    const to = band.upTo ?? Number.POSITIVE_INFINITY;
    if (units <= from) break;
    const inBand = Math.min(units, to) - from;
    if (inBand > 0) cost += (inBand / 1000) * band.perThousandUsd;
    from = Math.max(from, to);
  }
  return Math.round(cost * 100) / 100;
}

export interface CostLine {
  label: string;
  units: number;
  freeUnits: number;
  usd: number;
}

export type CostEstimate = { kind: 'known'; lines: CostLine[]; totalUsd: number } | { kind: 'free'; note: string } | { kind: 'depends'; note: string } | { kind: 'unknown'; note: string };

export interface Source {
  label: string;
  url: string;
}

export type Level = 'good' | 'ok' | 'watch' | 'poor';

export interface Judgement {
  level: Level;
  /** What the provider itself publishes, or our own view (then `ours` is true and the screen says so). */
  text: string;
  ours?: boolean;
}

export interface GeoProviderInfo {
  id: GeoProviderId;
  name: string;
  tagline: string;
  /** The adapter is installed in this system; a provider without one is shown for comparison and cannot be chosen yet. */
  adapterReady: boolean;
  needsKey: boolean;
  /** What each of the things that matter looks like for this provider. */
  cost: Judgement;
  reliability: Judgement;
  limits: Judgement;
  typeahead: Judgement;
  roadDistance: Judgement;
  kenyaData: Judgement;
  terms: string[];
  bestFor: string;
  watchOut: string[];
  sources: Source[];
}

const GOOGLE_SKU = {
  geocoding: { free: 10_000, bands: [{ upTo: 100_000, perThousandUsd: 5 }, { upTo: 500_000, perThousandUsd: 4 }, { upTo: 1_000_000, perThousandUsd: 3 }, { upTo: 5_000_000, perThousandUsd: 1.5 }, { upTo: null, perThousandUsd: 0.38 }] },
  routeMatrix: { free: 10_000, bands: [{ upTo: 100_000, perThousandUsd: 5 }, { upTo: 500_000, perThousandUsd: 4 }, { upTo: 1_000_000, perThousandUsd: 3 }, { upTo: 5_000_000, perThousandUsd: 1.5 }, { upTo: null, perThousandUsd: 0.38 }] },
  dynamicMaps: { free: 10_000, bands: [{ upTo: 100_000, perThousandUsd: 7 }, { upTo: 500_000, perThousandUsd: 5.6 }, { upTo: 1_000_000, perThousandUsd: 4.2 }, { upTo: 5_000_000, perThousandUsd: 2.1 }, { upTo: null, perThousandUsd: 0.53 }] },
} as const satisfies Record<string, Tiered>;

export const GEO_PROVIDERS: Record<GeoProviderId, GeoProviderInfo> = {
  builtin: {
    id: 'builtin',
    name: 'Built-in estimate',
    tagline: 'No map service. Distances are the straight line times a road factor.',
    adapterReady: true,
    needsKey: false,
    cost: { level: 'good', text: 'Free. Nothing to sign up for.' },
    reliability: { level: 'good', text: 'Always available: it runs inside the system and needs no network.' },
    limits: { level: 'good', text: 'None.' },
    typeahead: { level: 'poor', text: 'No address search and no map: customers write an address, drop a pin on a map you supply, or use their device location.' },
    roadDistance: { level: 'poor', text: 'An estimate, not a road distance. It can be wrong where roads wind or a river or hill is in the way. Charges are marked approximate.', ours: true },
    kenyaData: { level: 'poor', text: 'Not applicable: it knows no places, only coordinates.' },
    terms: [],
    bestFor: 'Getting started, small areas with straight roads, or a fallback when a map service is down (it is always the fallback).',
    watchOut: ['Charges by distance are only as good as the road factor you set.', 'Customers cannot search for a place or see a map.'],
    sources: [],
  },
  osm: {
    id: 'osm',
    name: 'OpenStreetMap',
    tagline: 'Free community map data. Search by Nominatim, roads and times by OSRM, maps drawn with Leaflet.',
    adapterReady: true,
    needsKey: false,
    cost: { level: 'good', text: 'Free on the public servers. Hosting your own, or paying a host that runs the same software, costs what that host charges.' },
    reliability: { level: 'watch', text: 'The public servers are run on donations with no uptime promise and can be switched off or limited at any time. The system falls back to the built-in estimate when they fail, so a sale is never stopped.' },
    limits: { level: 'watch', text: 'Public search: at most 1 request a second for your whole business, results should be cached. Public tiles: normal viewing only, no bulk downloading.' },
    typeahead: { level: 'watch', text: 'Searching as people type is forbidden on the public search server, so customers press Search. A server of your own or a paid host can allow it.' },
    roadDistance: { level: 'good', text: 'Real road distances and travel times from the routing server.' },
    kenyaData: { level: 'ok', text: 'Good in Nairobi, Mombasa and other towns; thinner for estates, plot numbers and rural roads, where it depends on local mappers.', ours: true },
    terms: ['Show "© OpenStreetMap contributors" on every map.', 'Identify your business to the public servers (a contact email is required here).', 'Do not hide or strip the referrer on map tiles.'],
    bestFor: 'Most Kenyan shops starting with delivery: no cost, no card, real roads. Move to a paid host or your own server as order volume grows.',
    watchOut: ['No service-level promise on the public servers.', 'Addresses are less exact than Google in newer estates.', 'Heavy use of the public servers can be blocked without notice.'],
    sources: [
      { label: 'Nominatim usage policy', url: 'https://operations.osmfoundation.org/policies/nominatim/' },
      { label: 'Tile usage policy', url: 'https://operations.osmfoundation.org/policies/tiles/' },
      { label: 'OSRM demo server', url: 'https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server' },
    ],
  },
  google: {
    id: 'google',
    name: 'Google Maps Platform',
    tagline: 'The most complete address data and a published uptime target, paid by use after a monthly free allowance.',
    adapterReady: false,
    needsKey: true,
    cost: { level: 'ok', text: 'Pay by use. Each service has a monthly free allowance (10,000 calls for geocoding, route matrix and maps at the basic edition), then about US$5 per 1,000 geocodes and route elements and US$7 per 1,000 map views, cheaper at higher volume. A billing account with a card is required.' },
    reliability: { level: 'good', text: 'Google commits to a 99.9% monthly uptime target for its core services, with service credits of 10%, 25% or 50% of the month’s bill when it is missed.' },
    limits: { level: 'good', text: 'Generous quotas that you can raise; a spending cap can be set in your Google account.' },
    typeahead: { level: 'good', text: 'Search as people type is allowed and billed per session.' },
    roadDistance: { level: 'good', text: 'Road distances and travel times, optionally with live traffic (billed at a higher edition).' },
    kenyaData: { level: 'good', text: 'The most detailed place and address data in Kenya, including businesses and newer estates.', ours: true },
    terms: ['Google’s terms limit storing and re-using its results, so geocodes cannot be kept as your own database.', 'The Google logo must show on its maps.'],
    bestFor: 'Businesses where wrong addresses cost money, or whose order volume justifies the bill.',
    watchOut: ['The bill grows with every order; set a budget alert and a cap in your Google account.', 'Needs an API key and a billing account.', 'Results cannot be stored for later use beyond what the terms allow.'],
    sources: [
      { label: 'Google Maps Platform pricing', url: 'https://developers.google.com/maps/billing-and-pricing/pricing' },
      { label: 'Google Maps Platform SLA', url: 'https://cloud.google.com/maps-platform/terms/sla' },
    ],
  },
  mapbox: {
    id: 'mapbox',
    name: 'Mapbox',
    tagline: 'Commercial maps built on OpenStreetMap data, with search, routing and a matrix service, paid by use.',
    adapterReady: false,
    needsKey: true,
    cost: { level: 'ok', text: 'Pay by use after a monthly free allowance. The figures found in public sources disagreed, so none is shown here: read the current price on Mapbox’s own page.' },
    reliability: { level: 'ok', text: 'A commercial service with a status page; read its current service terms before relying on a number.' },
    limits: { level: 'ok', text: 'Quotas per account that can be raised.' },
    typeahead: { level: 'good', text: 'Search as people type is supported.' },
    roadDistance: { level: 'good', text: 'Road distances and times from the Matrix and Directions services.' },
    kenyaData: { level: 'ok', text: 'Built largely on OpenStreetMap, with additions of its own.', ours: true },
    terms: ['Show Mapbox and OpenStreetMap attribution on maps.', 'Check what its terms say about storing results.'],
    bestFor: 'A middle path: more support and a guaranteed service than the free OpenStreetMap servers, usually cheaper than Google.',
    watchOut: ['Needs an access token and billing details.', 'Prices could not be confirmed here: check before choosing.'],
    sources: [{ label: 'Mapbox pricing', url: 'https://www.mapbox.com/pricing' }],
  },
};

/** What a month of this business's usage costs on a provider, in US dollars where the price is published. */
export function estimateCost(id: GeoProviderId, usage: UsageProfile): CostEstimate {
  const v = monthlyVolumes(usage);
  switch (id) {
    case 'builtin':
      return { kind: 'free', note: 'Nothing to pay.' };
    case 'osm':
      return { kind: 'free', note: 'Nothing to pay on the public servers. A paid host or your own server has its own bill.' };
    case 'google': {
      const lines: CostLine[] = [
        { label: 'Address searches and pin lookups (Geocoding)', units: v.lookups, freeUnits: GOOGLE_SKU.geocoding.free, usd: tieredCostUsd(v.lookups, GOOGLE_SKU.geocoding) },
        { label: 'Distances (Route Matrix elements)', units: v.routeElements, freeUnits: GOOGLE_SKU.routeMatrix.free, usd: tieredCostUsd(v.routeElements, GOOGLE_SKU.routeMatrix) },
        { label: 'Map views (Dynamic Maps)', units: v.mapViews, freeUnits: GOOGLE_SKU.dynamicMaps.free, usd: tieredCostUsd(v.mapViews, GOOGLE_SKU.dynamicMaps) },
      ];
      return { kind: 'known', lines, totalUsd: Math.round(lines.reduce((n, l) => n + l.usd, 0) * 100) / 100 };
    }
    case 'mapbox':
      return { kind: 'unknown', note: 'Price not confirmed from Mapbox’s own page. See the link.' };
  }
}

export interface Fit {
  level: Level;
  text: string;
}

/** Whether a provider suits this volume. The thresholds for the free OpenStreetMap servers are our rule of thumb, not a published limit. */
export function volumeFit(id: GeoProviderId, usage: UsageProfile): Fit {
  const v = monthlyVolumes(usage);
  if (id === 'osm') {
    const perDay = (v.lookups + v.routeRequests) / 30;
    if (perDay > 5_000) return { level: 'poor', text: `About ${Math.round(perDay).toLocaleString('en-KE')} map requests a day is more than the free servers can fairly be asked to carry. Use a paid host or your own server.` };
    if (perDay > 1_000) return { level: 'watch', text: `About ${Math.round(perDay).toLocaleString('en-KE')} map requests a day is heavy for the free servers. Plan to move to a paid host.` };
    return { level: 'good', text: `About ${Math.round(perDay).toLocaleString('en-KE')} map requests a day is light enough for the free servers.` };
  }
  if (id === 'builtin') return { level: 'good', text: 'Any volume: it runs inside the system.' };
  return { level: 'good', text: 'Any volume, at the price shown.' };
}

export interface ConfigField {
  key: string;
  label: string;
  hint: string;
  kind: 'url' | 'text' | 'email' | 'codes';
  required: boolean;
  placeholder: string;
}

/** The settings each provider needs, shown as the form after choosing it. Values are checked on the server again. */
export const GEO_CONFIG_FIELDS: Record<GeoProviderId, readonly ConfigField[]> = {
  builtin: [],
  osm: [
    { key: 'contactEmail', label: 'Contact email', hint: 'Sent to OpenStreetMap’s servers so they can reach you if your use causes a problem. Their rules require it.', kind: 'email', required: true, placeholder: 'maps@yourshop.co.ke' },
    { key: 'countryCodes', label: 'Countries to search in', hint: 'Two-letter codes, separated by commas. Keeps results to where you deliver.', kind: 'codes', required: false, placeholder: 'ke' },
    { key: 'nominatimUrl', label: 'Address search server', hint: 'Leave empty for the free public server. Fill in to use a host or a server of your own.', kind: 'url', required: false, placeholder: 'https://nominatim.openstreetmap.org' },
    { key: 'osrmUrl', label: 'Road distance server', hint: 'Leave empty for the free public server. Fill in to use a host or a server of your own.', kind: 'url', required: false, placeholder: 'https://router.project-osrm.org' },
    { key: 'tileUrl', label: 'Map picture server', hint: 'Leave empty for the free public tiles. Heavy use needs a tile host of your own.', kind: 'url', required: false, placeholder: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  ],
  google: [],
  mapbox: [],
};
