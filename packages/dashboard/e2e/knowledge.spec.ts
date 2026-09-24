import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
}

test('navigates knowledge views, renders citations, and resolves a review', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Knowledge');
  await expect(page.getByText('Ariadne workspace')).toBeVisible();
  await expect(page.getByLabel('Knowledge totals')).toContainText('Sources');

  await harness.navigate('Search');
  await page.getByLabel('Search knowledge').fill('queue');
  await page.locator('.knowledge-search-form').getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('Queue recovery')).toBeVisible();
  await expect(page.getByText('docs/queue.md - Recovery')).toBeVisible();

  await harness.navigate('Reviews');
  await expect(page.getByText('Confirm the queue recovery guidance')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('No pending reviews')).toBeVisible();
});

test('keeps knowledge views usable at phone width', async ({ harness, page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await harness.openAuthenticatedConsole();

  await harness.navigate('Knowledge');
  await expectNoHorizontalOverflow(page);
  await harness.navigate('Search');
  await page.getByLabel('Search knowledge').fill('queue');
  await page.locator('.knowledge-search-form').getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('Queue recovery')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
