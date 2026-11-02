import { expect, test, type Locator } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

/** Brings a button to the middle of the screen first; on a phone the development badge covers the bottom corner. */
async function press(button: Locator): Promise<void> {
  await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await button.click();
}

test.describe('map service', () => {
  test('services are compared with the shop’s own numbers, one is chosen with a reason and settings, and the choice can be undone', async ({ page }) => {
    test.slow();
    await open(page, '/admin/delivery/maps', 'Map service');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // Four services are laid out the same way; two can be chosen, two are shown for comparison.
    for (const name of ['Built-in estimate', 'OpenStreetMap', 'Google Maps Platform', 'Mapbox']) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose Google Maps Platform' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Choose Mapbox' })).toBeDisabled();
    const google = page.getByRole('group', { name: 'Google Maps Platform: cost at your volume' });
    const osm = page.getByRole('group', { name: 'OpenStreetMap: cost at your volume' });

    // Cost follows the volume: a small shop is inside Google's free allowance, a busy one is not; the free servers stay free but are flagged.
    const volume = page.getByRole('region', { name: 'Your volume' });
    await volume.getByLabel('Branches').fill('3');
    await volume.getByLabel('Orders a month').fill('1000');
    await expect(google).toContainText('Nothing: inside the free allowance');
    await expect(osm).toContainText('light enough for the free servers');
    await volume.getByLabel('Orders a month').fill('10000');
    await expect(google).toContainText('about US$500');
    await expect(google).toContainText('Geocoding');
    await volume.getByLabel('KES per US$ (optional)').fill('130');
    await expect(google).toContainText('about KES 65,000');
    await volume.getByLabel('Orders a month').fill('100000');
    await expect(osm).toContainText('Use a paid host or your own server');
    await noInnerHorizontalScroll(page);

    // Choosing OpenStreetMap asks for the contact email its rules require, and a reason; a bad server address is refused in words.
    await press(page.getByRole('button', { name: 'Choose OpenStreetMap' }));
    const setup = page.getByRole('form', { name: 'Set up OpenStreetMap' });
    await expect(setup.getByRole('button', { name: 'Use OpenStreetMap' })).toBeDisabled();
    await setup.getByLabel(/Contact email/).fill('maps@e2e-shop.co.ke');
    await setup.getByLabel(/Address search server/).fill('http://insecure.example.com');
    await setup.getByLabel('Why? (kept with the change)').fill('Trying the free maps');
    await press(setup.getByRole('button', { name: 'Use OpenStreetMap' }));
    await expect(page.getByRole('alert').filter({ hasText: 'must start with https://' })).toBeVisible({ timeout: 30_000 });
    await setup.getByLabel(/Address search server/).fill('');
    await press(setup.getByRole('button', { name: 'Use OpenStreetMap' }));
    await expect(page.getByText('OpenStreetMap is now the map service.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'OpenStreetMap', exact: true })).toContainText('In use');

    // Back to the built-in estimate, which can be tried without leaving the building: three steps, all worked.
    await press(page.getByRole('button', { name: 'Choose Built-in estimate' }));
    const back = page.getByRole('form', { name: 'Set up Built-in estimate' });
    await press(back.getByRole('button', { name: 'Try it now' }));
    const found = back.getByRole('list', { name: 'What the try found' });
    await expect(found.getByRole('listitem')).toHaveCount(3, { timeout: 30_000 });
    await expect(found).toContainText('Measure a road (Nairobi to Nakuru)');
    await back.getByLabel('Why? (kept with the change)').fill('Back to the estimate for the tests');
    await press(back.getByRole('button', { name: 'Use Built-in estimate' }));
    await expect(page.getByText('Built-in estimate is now the map service.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Built-in estimate', exact: true })).toContainText('In use');
    await expect(page.getByRole('region', { name: 'OpenStreetMap', exact: true })).not.toContainText('In use');
  });
});
