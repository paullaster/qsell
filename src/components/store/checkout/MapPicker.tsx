'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type * as LeafletModule from 'leaflet';
import type { Map as LeafletMap, Marker } from 'leaflet';
import type { GeoPoint } from '@/lib/geo';

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * A map to drop the delivery pin on: click to place it, drag it to adjust. The pictures come from the map service the shop
 * chose (its address is a setting, never hard-coded here), with its credit shown on the map as its terms require. Leaflet
 * is loaded only in the browser and only when this map is shown, so a shop that does not use it ships none of it.
 * A map cannot be used by keyboard, so the written address and "use my location" are always offered beside it.
 */
export function MapPicker({ tileUrl, attribution, centre, pin, onPin, label }: { tileUrl: string; attribution: string; centre: GeoPoint; pin: GeoPoint | null; onPin: (point: GeoPoint) => void; label: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const leaflet = useRef<typeof LeafletModule | null>(null);
  const onPinRef = useRef(onPin);
  const first = useRef({ centre, pin, tileUrl, attribution });

  useEffect(() => {
    onPinRef.current = onPin;
  }, [onPin]);

  // Draw the map once, when it is first on screen.
  useEffect(() => {
    let gone = false;
    void import('leaflet').then((L) => {
      const element = box.current;
      if (gone || element === null || map.current !== null) return;
      leaflet.current = L;
      const start = first.current;
      const m = L.map(element, { center: [(start.pin ?? start.centre).latitude, (start.pin ?? start.centre).longitude], zoom: start.pin === null ? 12 : 16, scrollWheelZoom: false });
      L.tileLayer(start.tileUrl, { attribution: start.attribution, maxZoom: 19 }).addTo(m);
      const icon = L.divIcon({ className: 'bg-transparent border-0', html: '<span class="block size-6 rounded-full border-4 border-white bg-indigo-600 shadow-lg"></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
      const place = (lat: number, lng: number) => {
        if (marker.current === null) {
          const mk = L.marker([lat, lng], { icon, draggable: true, keyboard: false }).addTo(m);
          mk.on('dragend', () => {
            const at = mk.getLatLng();
            onPinRef.current({ latitude: round(at.lat), longitude: round(at.lng) });
          });
          marker.current = mk;
        } else {
          marker.current.setLatLng([lat, lng]);
        }
      };
      if (start.pin !== null) place(start.pin.latitude, start.pin.longitude);
      m.on('click', (e) => {
        place(e.latlng.lat, e.latlng.lng);
        onPinRef.current({ latitude: round(e.latlng.lat), longitude: round(e.latlng.lng) });
      });
      map.current = m;
    });
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);

  // A pin set some other way (a search result, the device's location) moves the marker and the view.
  useEffect(() => {
    const m = map.current;
    const L = leaflet.current;
    if (m === null || L === null || pin === null) return;
    if (marker.current !== null) {
      const at = marker.current.getLatLng();
      if (round(at.lat) === pin.latitude && round(at.lng) === pin.longitude) return;
      marker.current.setLatLng([pin.latitude, pin.longitude]);
    } else {
      const icon = L.divIcon({ className: 'bg-transparent border-0', html: '<span class="block size-6 rounded-full border-4 border-white bg-indigo-600 shadow-lg"></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
      marker.current = L.marker([pin.latitude, pin.longitude], { icon, draggable: true, keyboard: false }).addTo(m);
      marker.current.on('dragend', () => {
        const at = marker.current?.getLatLng();
        if (at !== undefined) onPinRef.current({ latitude: round(at.lat), longitude: round(at.lng) });
      });
    }
    m.setView([pin.latitude, pin.longitude], Math.max(m.getZoom(), 16));
  }, [pin]);

  return <div ref={box} role="application" aria-label={label} className="z-0 h-64 w-full rounded-xl border border-line bg-surface-raised" />;
}
