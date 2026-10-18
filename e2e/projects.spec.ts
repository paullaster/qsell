import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

const tagOf = (project: string): string => (project === 'phone' ? 'Phone' : 'Desktop');

test.describe('projects', () => {
  test('a draft is saved, given a task, and opened, with no native dropdown and no sideways scrolling', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const tag = tagOf(testInfo.project.name);
    const name = `Fit-out ${tag} ${String(Date.now())}`;
    await open(page, '/admin/projects', 'Projects');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const newProject = page.getByRole('heading', { name: 'New project', level: 2 });
    // Click again only while the new page is still absent. Clicking during the navigation aborts it.
    await expect(async () => {
      if (await newProject.isVisible()) return;
      await page.getByRole('link', { name: 'New project' }).click();
      await expect(newProject).toBeVisible({ timeout: 20_000 });
    }).toPass({ timeout: 90_000 });
    await noNativeSelect(page);

    const form = page.getByRole('form', { name: 'New project' });
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Currency').fill('KES');
    await form.getByLabel('Budget').fill('1000');
    await form.getByRole('button', { name: 'Save project' }).click();
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await noNativeSelect(page);

    const task = page.getByRole('form', { name: 'Add a task' });
    await task.getByLabel('Code').fill('site-1');
    await task.getByLabel('Task name').fill('Measure');
    await task.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByText('Task added.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('SITE-1')).toBeVisible();

    await page.getByRole('button', { name: 'Open project' }).click();
    await expect(page.getByText('Project opened.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Open', { exact: true }).first()).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
