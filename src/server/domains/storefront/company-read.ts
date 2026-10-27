import { cache } from 'react';
import { getContainer } from '@/server/di/container';

/**
 * The company's row, read once per request however many parts of the page ask (the root layout, the shop frame, the metadata, the
 * sitemap). Without this the same query ran once for each of them, side by side, each on a connection of its own.
 * Only the public shop reads through here: the console's own screens read fresh, so a save is never shown stale.
 */
export const readCompanyRow = cache(async () => await getContainer().companySettings.ensureSeeded());
