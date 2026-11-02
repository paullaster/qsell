'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GeoPoint } from '@/lib/geo';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { shopDeliveryOptionsAction, shopNamePinAction, shopPickupPointsAction, shopQuoteDeliveryAction, shopSearchPlacesAction, type ShopDeliveryOptions, type ShopDeliveryQuote, type ShopPickupPoint, type ShopPinPlace, type ShopPlace } from '@/server/domains/delivery/shop-actions';

export type Method = 'own_fleet' | 'courier' | 'pickup';

export type QuotePhase = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ok'; quote: ShopDeliveryQuote } | { phase: 'error'; error: string };

interface Answer {
  key: string;
  outcome: { ok: true; quote: ShopDeliveryQuote } | { ok: false; error: string };
}

export interface ShopDelivery {
  /** null while the shop's delivery options are being read; `off` when the shop has no delivery rules to offer. */
  options: ShopDeliveryOptions | null;
  loaded: boolean;
  off: boolean;
  method: Method;
  setMethod: (m: Method) => void;
  pin: GeoPoint | null;
  setPin: (p: GeoPoint | null) => void;
  quote: QuotePhase;
  /** The words of the pin's address, offered to fill the address fields. */
  named: ShopPinPlace | null;
  nameNotice: string | null;
  search: { text: string; setText: (t: string) => void; run: () => void; results: ShopPlace[]; busy: boolean; error: string | null };
  locate: { run: () => void; busy: boolean; error: string | null };
  /** Collecting from a branch: the branches this basket can be collected from, and the one chosen. */
  pickup: { points: ShopPickupPoint[] | null; error: string | null; chosen: string | null; choose: (branchId: string) => void };
}

interface Input {
  items: { productId: string; quantity: number }[];
  county: string;
  town: string;
  area: string;
  country: string;
}

/**
 * The shop's delivery, as a shopper uses it: a pin (dropped, searched or from the device) or a written area, and what delivery
 * then costs. The price is asked of the server whenever the place or the basket changes, after a short pause, and an answer to
 * an earlier question is never shown for a later one.
 */
export function useShopDelivery(input: Input): ShopDelivery {
  const [options, setOptions] = useState<ShopDeliveryOptions | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [method, setMethod] = useState<Method>('own_fleet');
  const [pin, setPinState] = useState<GeoPoint | null>(null);
  const [named, setNamed] = useState<ShopPinPlace | null>(null);
  const [nameNotice, setNameNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState<ShopPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [chosenBranch, setChosenBranch] = useState<string | null>(null);
  const [points, setPoints] = useState<{ key: string; list: ShopPickupPoint[] } | { key: string; error: string } | null>(null);

  useEffect(() => {
    let live = true;
    void shopDeliveryOptionsAction().then((r) => {
      if (!live) return;
      setLoaded(true);
      if (r.ok) {
        setOptions(r.data);
        const first = r.data.methods[0];
        if (first !== undefined) setMethod(first);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const hasPlace = pin !== null || input.county.trim() !== '' || input.town.trim() !== '' || input.area.trim() !== '';
  const basketKey = JSON.stringify(input.items);
  // The branches to collect from are asked for when collecting is chosen and the basket is known; a choice the basket no longer allows is dropped.
  useEffect(() => {
    if (method !== 'pickup' || input.items.length === 0) return;
    let live = true;
    void shopPickupPointsAction({ items: input.items }).then((r) => {
      if (!live) return;
      if (!r.ok) {
        setPoints({ key: basketKey, error: r.error });
        return;
      }
      setPoints({ key: basketKey, list: r.data });
      setChosenBranch((current) => (current !== null && r.data.some((p) => p.branchId === current && p.holdsAll) ? current : null));
    });
    return () => {
      live = false;
    };
    // The basket is compared by its content, not by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, basketKey]);
  const request = JSON.stringify({ method, pickupBranchId: method === 'pickup' ? chosenBranch : null, pin, county: input.county.trim(), town: input.town.trim(), area: input.area.trim(), country: input.country.trim(), items: input.items });
  const asked = useDebouncedValue(request, 700);
  const active = options !== null && options.methods.length > 0 && (method === 'pickup' ? chosenBranch !== null : hasPlace) && input.items.length > 0;

  useEffect(() => {
    if (!active) return;
    let live = true;
    const body = JSON.parse(asked) as { method: Method; pickupBranchId: string | null; pin: GeoPoint | null; county: string; town: string; area: string; country: string; items: Input['items'] };
    void shopQuoteDeliveryAction({ method: body.method, pickupBranchId: body.pickupBranchId, pin: body.pin, address: { county: body.county, town: body.town, area: body.area, country: body.country }, items: body.items }).then((r) => {
      if (live) setAnswer({ key: asked, outcome: r.ok ? { ok: true, quote: r.data } : { ok: false, error: r.error } });
    });
    return () => {
      live = false;
    };
  }, [asked, active]);

  let quote: QuotePhase = { phase: 'idle' };
  if (active) {
    if (answer !== null && answer.key === request) quote = answer.outcome.ok ? { phase: 'ok', quote: answer.outcome.quote } : { phase: 'error', error: answer.outcome.error };
    else quote = { phase: 'loading' };
  }

  const setPin = useCallback((p: GeoPoint | null) => {
    setPinState(p);
    setNamed(null);
    setNameNotice(null);
    if (p === null) return;
    void shopNamePinAction(p).then((r) => {
      if (r.ok && r.data !== null) setNamed(r.data);
      else if (!r.ok) setNameNotice(r.error);
    });
  }, []);

  const run = () => {
    setSearching(true);
    setSearchError(null);
    void shopSearchPlacesAction({ q: text }).then((r) => {
      setSearching(false);
      if (!r.ok) {
        setResults([]);
        setSearchError(r.error);
        return;
      }
      setResults(r.data);
      if (r.data.length === 0) setSearchError('We found no place by that name. Try another spelling, or drop a pin on the map.');
    });
  };

  const locateMe = () => {
    setLocateError(null);
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setLocateError('Your device cannot share its location. Drop a pin on the map or write your area.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setPin({ latitude: Math.round(position.coords.latitude * 1e6) / 1e6, longitude: Math.round(position.coords.longitude * 1e6) / 1e6 });
      },
      () => {
        setLocating(false);
        setLocateError('We could not get your location. Allow location for this site, or drop a pin on the map.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };

  return {
    options,
    loaded,
    off: loaded && (options === null || options.methods.length === 0),
    method,
    setMethod,
    pin,
    setPin,
    quote,
    named,
    nameNotice,
    search: { text, setText, run, results, busy: searching, error: searchError },
    locate: { run: locateMe, busy: locating, error: locateError },
    pickup: {
      points: points !== null && 'list' in points && points.key === basketKey ? points.list : null,
      error: points !== null && 'error' in points && points.key === basketKey ? points.error : null,
      chosen: chosenBranch,
      choose: setChosenBranch,
    },
  };
}
