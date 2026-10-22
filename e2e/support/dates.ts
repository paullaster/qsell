/**
 * The company's calendar day, which is what the server counts "today" in (Africa/Nairobi). The UTC date is a day behind it from
 * 21:00 to midnight UTC, and a rate or a payment dated "today" by the UTC clock is then refused as a day that has passed.
 */
export const businessDay = (daysAhead = 0): string =>
  new Date(Date.now() + daysAhead * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
