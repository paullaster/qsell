import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('delivery zones', () => {
  test('a zone is added, given places one at a time and many at once, kept to one zone per place, changed, stopped and restarted', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const west = `W${tag}`;
    const south = `S${tag}`;
    await open(page, '/admin/delivery/zones', 'Delivery zones');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // A new zone: refused with words when it is not one, then made.
    await page.getByRole('button', { name: 'New zone' }).click();
    const form = page.getByRole('form', { name: 'New delivery zone' });
    await form.getByLabel('Code').fill('bad code!');
    await form.getByLabel('Name').fill(`Westlands ${tag}`);
    await form.getByRole('button', { name: 'Add zone' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /code is up to 20/i })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Code').fill(west.toLowerCase());
    await form.getByLabel('Centre latitude').fill('-1.2640');
    await form.getByRole('button', { name: 'Add zone' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /needs a latitude, a longitude and a radius/ })).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Centre longitude').fill('36.8070');
    await form.getByLabel('Radius in kilometres').fill('4');
    await form.getByRole('button', { name: 'Add zone' }).click();
    await expect(page.getByText(`${west} added.`)).toBeVisible({ timeout: 30_000 });

    // The same code again is refused in words; a second zone for the shared place test is made.
    await page.getByRole('button', { name: 'New zone' }).click();
    const again = page.getByRole('form', { name: 'New delivery zone' });
    await again.getByLabel('Code').fill(west);
    await again.getByLabel('Name').fill('Again');
    await again.getByRole('button', { name: 'Add zone' }).click();
    await expect(page.getByRole('alert').filter({ hasText: `A zone with the code ${west} already exists.` })).toBeVisible({ timeout: 30_000 });
    await again.getByLabel('Code').fill(south);
    await again.getByLabel('Name').fill(`South ${tag}`);
    await again.getByRole('button', { name: 'Add zone' }).click();
    await expect(page.getByText(`${south} added.`)).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Search zones').fill(tag);
    const list = page.getByRole('list', { name: 'Delivery zones' });
    const westRow = list.getByRole('listitem').filter({ hasText: `Westlands ${tag}` });
    const southRow = list.getByRole('listitem').filter({ hasText: `South ${tag}` });
    await expect(westRow).toContainText('No places yet');
    await expect(westRow).toContainText('Pin circle: 4 km');
    await expect(southRow).toContainText('No pin circle');

    // Places: one by hand, then many pasted, with a place that is already in another zone skipped and said so.
    await westRow.getByRole('button', { name: `Show the places in ${west}` }).click();
    const westPlaces = page.getByRole('region', { name: `Places in ${west}` });
    await westPlaces.getByLabel('County').fill(`Nairobi ${tag}`);
    await westPlaces.getByLabel('Town').fill('Westlands');
    await westPlaces.getByRole('button', { name: 'Add place' }).click();
    await expect(page.getByText(`Added 1 place to ${west}.`)).toBeVisible({ timeout: 30_000 });
    await expect(westPlaces.getByRole('list', { name: `Places in ${west}` })).toContainText(`Westlands, Nairobi ${tag}`);
    await expect(westRow).toContainText('1 place');

    // Adding the place above reloads the list; a tap that lands in that reload is lost, so it is repeated until the panel opens.
    const southPlaces = page.getByRole('region', { name: `Places in ${south}` });
    await clickUntilVisible(southRow.getByRole('button', { name: `Show the places in ${south}` }), southPlaces);
    await southPlaces.getByRole('button', { name: 'Add many at once' }).click();
    await southPlaces.getByLabel('Places, one on each line').fill(`Nairobi ${tag}, westlands\nNairobi ${tag}, Karen\n,,\nNairobi ${tag}, KAREN`);
    await southPlaces.getByRole('button', { name: 'Add these places' }).click();
    await expect(page.getByText(`Added 1 place to ${south}.`)).toBeVisible({ timeout: 30_000 });
    const notAdded = southPlaces.getByRole('status').filter({ hasText: 'Not added' });
    await expect(notAdded).toContainText(`It is already in zone ${west}.`);
    await expect(notAdded).toContainText('Line 3');
    await expect(notAdded).toContainText('The same area is on an earlier line.');
    await expect(southPlaces.getByRole('list', { name: `Places in ${south}` })).toContainText(`Karen, Nairobi ${tag}`);

    // A place is removed after a confirmation.
    // The list reloads after a place is added; a tap that lands during that reload is lost, as it would be for a person, so it is repeated until the question appears.
    const confirmRemove = southPlaces.getByRole('button', { name: `Confirm: Remove Karen, Nairobi ${tag}` });
    await clickUntilVisible(southPlaces.getByRole('button', { name: `Remove Karen, Nairobi ${tag}` }), confirmRemove);
    await confirmRemove.click();
    await expect(page.getByText(`Karen, Nairobi ${tag} removed from ${south}.`)).toBeVisible({ timeout: 30_000 });
    await expect(southPlaces).toContainText('No places yet');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The zone is changed (the form keeps its values), stopped (and then hidden), and restarted.
    const edit = page.getByRole('form', { name: `Edit ${west}` });
    await clickUntilVisible(westRow.getByRole('button', { name: `Edit ${west}` }), edit);
    await expect(edit.getByLabel('Radius in kilometres')).toHaveValue('4');
    await edit.getByLabel('Name').fill(`Westlands central ${tag}`);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`${west} saved.`)).toBeVisible({ timeout: 30_000 });
    const renamed = list.getByRole('listitem').filter({ hasText: `Westlands central ${tag}` });
    await expect(renamed).toBeVisible({ timeout: 30_000 });

    const confirmStop = renamed.getByRole('button', { name: `Confirm: Stop ${west}` });
    await clickUntilVisible(renamed.getByRole('button', { name: `Stop ${west}` }), confirmStop);
    await confirmStop.click();
    await expect(page.getByText(`${west} stopped.`)).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem').filter({ hasText: `Westlands central ${tag}` })).toHaveCount(0);
    await page.getByLabel('Show stopped zones').check();
    const stopped = list.getByRole('listitem').filter({ hasText: `Westlands central ${tag}` });
    await expect(stopped).toContainText('Stopped', { timeout: 30_000 });
    await stopped.getByRole('button', { name: `Restart ${west}` }).click();
    await expect(page.getByText(`${west} is in use again.`)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
