/**
 * Where this device is now, or null when it cannot say (no permission, no signal, no support, or too slow). The browser's own question is the
 * only thing here that is not pure; it is kept apart so screens just ask for a position and carry on without one.
 */
export interface DevicePosition {
  latitude: number;
  longitude: number;
}

export function currentPosition(timeoutMs = 8000): Promise<DevicePosition | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}
