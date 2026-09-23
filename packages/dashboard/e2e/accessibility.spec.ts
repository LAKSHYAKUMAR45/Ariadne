import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function injectAxe(page: Page): Promise<void> {
  await page.addScriptTag({ content: axeSource });
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  await injectAxe(page);
  const results = await page.evaluate(async () => {
    const axe = (window as Window & { axe: { run: (root?: Element | Document) => Promise<{ violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }> }> } }).axe;
    return axe.run(document);
  });

  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

async function focusWithKeyboard(page: Page, target: Locator, maxTabs = 30): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }

  throw new Error('Could not reach target with keyboard navigation.');
}

async function expectVisibleFocus(target: Locator): Promise<void> {
  const focusStyles = await target.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth,
      outlineColor: styles.outlineColor,
    };
  });

  expect(focusStyles.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(focusStyles.outlineWidth)).toBeGreaterThan(0);
  expect(focusStyles.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
}

test('passes axe on login and every primary page', async ({ harness, page }) => {
  await harness.gotoConsole();
  await expectNoAxeViolations(page);
  await harness.login();

  for (const section of ['Overview', 'Members', 'Tasks', 'Backups', 'Services', 'Deployments', 'Logs', 'Audit'] as const) {
    if (section !== 'Overview') {
      await harness.navigate(section);
    }
    await expectNoAxeViolations(page);
  }
});

test('keeps keyboard, dialog, landmark, and status semantics accessible', async ({ harness, page }) => {
  harness.failNextLogin();
  await harness.gotoConsole();

  await page.getByLabel('Username').fill('ops-admin');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Open console' }).click();

  const loginError = page.getByRole('alert');
  await expect(loginError).toBeFocused();
  await expect(loginError).toContainText('Incorrect username or password.');

  await page.getByLabel('Password').fill('dashboard-password-123456');
  await page.getByRole('button', { name: 'Open console' }).click();

  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await focusWithKeyboard(page, skipLink);
  await expectVisibleFocus(skipLink);
  await skipLink.press('Enter');

  await expect(page.getByRole('main', { name: 'Overview section' })).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  await harness.navigate('Logs');
  const sourceSelect = page.getByLabel('Source');
  await focusWithKeyboard(page, sourceSelect);
  await expectVisibleFocus(sourceSelect);

  await harness.navigate('Members');
  await expect(page.getByRole('columnheader', { name: 'Username' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deactivate ops-member' })).toBeVisible();
  await expect(page.getByText('active').first()).toBeVisible();

  const trigger = page.getByRole('button', { name: 'Deactivate ops-member' });
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Deactivate member' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Type DEACTIVATE ops-member to continue')).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Type DEACTIVATE ops-member to continue')).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(trigger).toBeFocused();
});
