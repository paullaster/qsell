'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GeoPoint } from '@/lib/geo';
import type { ShopSlotOffer } from '@/lib/delivery-slot';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { shopDeliveryOptionsAction, shopDeliverySlotsAction, shopNamePinAction, shopPickupPointsAction, shopQuoteDeliveryAction, shopSearchPlacesAction, type ShopDeliveryOptions, type ShopDeliveryQuote, type ShopPickupPoint, type ShopPinPlace, type ShopPlace } from '@/server/domains/delivery/shop-actions';

export type Method = 'own_fleet' | 'courier' | 'pickup';

export type QuotePhase = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ok'; quote: ShopDeliveryQuote } | { phase: 'error'; error: string };

export type SlotsPhase = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ok'; offer: ShopSlotOffer } | { phase: 'error'; error: string };

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
  /** The delivery times on offer for this basket and place, and the one the shopper chose (none until they choose; the order does not need one). */
  slots: { phase: SlotsPhase; chosen: { slotId: string; day: string } | null; choose: (slot: { slotId: string; day: string } | null) => void };
  pickup: { points: ShopPickupPoint[] | null; error: string | null; chosen: string | null; choose: (branchId: string) => void };
}

interface Input {
  items: { productId: string; quantity: number }[];
  county: string;
  town: string;
  area: string;
  country: string;
}

/** The question the server is asked, from the request the hook keeps as text: the same one for the price and for the delivery times. */
function askOf(asked: string) {
  const body = JSON.parse(asked) as { method: Method; pickupBranchId: string | null; pin: GeoPoint | null; county: string; town: string; area: string; country: string; items: Input['items'] };
  return { method: body.method, pickupBranchId: body.pickupBranchId, pin: body.pin, address: { county: body.county, town: body.town, area: body.area, country: body.country }, items: body.items };
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
  const [slotAnswer, setSlotAnswer] = useState<({ key: string } & ({ offer: ShopSlotOffer } | { error: string })) | null>(null);
  const [chosenSlot, setChosenSlot] = useState<{ slotId: string; day: string } | null>(null);
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
    void shopQuoteDeliveryAction(askOf(asked)).then((r) => {
      if (live) setAnswer({ key: asked, outcome: r.ok ? { ok: true, quote: r.data } : { ok: false, error: r.error } });
    });
    return () => {
      live = false;
    };
  }, [asked, active]);

  // The delivery times are asked for with the same question as the price, since both depend on the place and the basket. Collecting has none.
  const slotsOn = active && method !== 'pickup';
  useEffect(() => {
    if (!slotsOn) return;
    let live = true;
    void shopDeliverySlotsAction(askOf(asked)).then((r) => {
      if (!live) return;
      setSlotAnswer(r.ok ? { key: asked, offer: r.data } : { key: asked, error: r.error });
      // A time that is no longer free for the new place or basket is dropped, so nothing stale is sent with the order.
      setChosenSlot((c) => (r.ok && c !== null && r.data.days.some((d) => d.day === c.day && d.slots.some((x) => x.slotId === c.slotId && x.available)) ? c : null));
    });
    return () => {
      live = false;
    };
  }, [asked, slotsOn]);

  let quote: QuotePhase = { phase: 'idle' };
  if (active) {
    if (answer !== null && answer.key === request) quote = answer.outcome.ok ? { phase: 'ok', quote: answer.outcome.quote } : { phase: 'error', error: answer.outcome.error };
    else quote = { phase: 'loading' };
  }

  let slots: SlotsPhase = { phase: 'idle' };
  if (slotsOn) {
    if (slotAnswer?.key !== asked) slots = { phase: 'loading' };
    else slots = 'offer' in slotAnswer ? { phase: 'ok', offer: slotAnswer.offer } : { phase: 'error', error: slotAnswer.error };
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
    slots: { phase: slots, chosen: slotsOn ? chosenSlot : null, choose: setChosenSlot },
    pickup: {
      points: points !== null && 'list' in points && points.key === basketKey ? points.list : null,
      error: points !== null && 'error' in points && points.key === basketKey ? points.error : null,
      chosen: chosenBranch,
      choose: setChosenBranch,
    },
  };
}
