/** Below this the device's place is as good as a person can drop a pin by hand: nothing is said. */
export const GOOD_ENOUGH_M = 200;

/**
 * What to tell a shopper whose device placed them only roughly (a laptop, or a phone indoors, can be kilometres out): how sure it is,
 * and what to do about it. Null when the place is precise enough or the device did not say.
 */
export function accuracyNote(meters: number | null | undefined): string | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= GOOD_ENOUGH_M) return null;
  const sure = meters >= 1000 ? `${(Math.round(meters / 100) / 10).toFixed(1)} km` : `${String(Math.round(meters / 10) * 10)} m`;
  return `Your device is only sure of where you are to within about ${sure}. Drag the pin to your door, or search for your place by name, so the rider comes to the right spot.`;
}
