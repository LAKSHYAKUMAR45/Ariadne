import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const VIEWPORTS = [
  { label: 'phone', width: 360, height: 800 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
}

async function expectDialogVisible(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) {
    return;
  }

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

for (const viewport of VIEWPORTS) {
  test(`remains usable without clipping at ${viewport.label} size`, async ({ harness, page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await harness.openAuthenticatedConsole();
    await expectNoHorizontalOverflow(page);

    await harness.navigate('Backups');
    await expect(page.getByRole('button', { name: 'Create backup' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await harness.navigate('Services');
    await page.getByRole('button', { name: 'Restart sync-server' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Restart sync-server' })).toBeVisible();

    await harness.navigate('Deployments');
    await page.getByRole('button', { name: 'Deploy selected revision' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Deploy selected revision' })).toBeVisible();

    await harness.navigate('Tasks');
    await page.getByRole('button', { name: /Finish the nodem2 operations console/ }).click();
    await page.getByRole('button', { name: 'src/console/panel.tsx' }).click();

    const tasksPane = page.locator('.task-list');
    const timelinePane = page.locator('.timeline-pane');
    const filePane = page.locator('.file-pane');

    if (viewport.width === 360) {
      await expect(tasksPane).not.toBeVisible();
      await expect(timelinePane).not.toBeVisible();
      await expect(filePane).toBeVisible();
      await page.getByRole('button', { name: 'Timeline' }).click();
      await expect(timelinePane).toBeVisible();
      await page.locator('.pane-toggle', { hasText: 'Tasks' }).click();
      await expect(tasksPane).toBeVisible();
      await page.getByRole('button', { name: /Finish the nodem2 operations console/ }).click();
      await page.getByRole('button', { name: 'src/console/panel.tsx' }).click();
    } else if (viewport.width === 768) {
      await expect(tasksPane).toBeVisible();
      await expect(timelinePane).toBeVisible();
      await expect(filePane).toBeVisible();
      const tasksBox = await tasksPane.boundingBox();
      const timelineBox = await timelinePane.boundingBox();
      const fileBox = await filePane.boundingBox();
      expect(tasksBox?.y ?? 0).toBeLessThan(fileBox?.y ?? 0);
      expect(timelineBox?.y ?? 0).toBeLessThan(fileBox?.y ?? 0);
    } else {
      await expect(tasksPane).toBeVisible();
      await expect(timelinePane).toBeVisible();
      await expect(filePane).toBeVisible();
      const tasksBox = await tasksPane.boundingBox();
      const timelineBox = await timelinePane.boundingBox();
      const fileBox = await filePane.boundingBox();
      expect(tasksBox?.x).toBeLessThan(timelineBox?.x ?? 0);
      expect(timelineBox?.x).toBeLessThan(fileBox?.x ?? 0);
    }

    await page.getByRole('button', { name: 'Delete capture capture-1' }).click();
    await expectDialogVisible(page);
  });
}
