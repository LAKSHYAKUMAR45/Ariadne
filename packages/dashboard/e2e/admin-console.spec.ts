import { test, expect } from './fixtures';

test('logs in, restores the session on reload, and logs out', async ({ harness, page }) => {
  await harness.gotoConsole();
  await harness.login();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'System overview' })).toBeVisible();
  await expect(page.getByText('nodem2 / production')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Command your Ariadne cloud' })).toBeVisible();
});

test('keeps database facts while showing overview partial failure', async ({ harness, page }) => {
  harness.setOverviewPartialFailure(true);
  await harness.openAuthenticatedConsole();

  await expect(page.getByText('operator_unavailable').first()).toBeVisible();
  await expect(page.getByText('Host metrics unavailable').first()).toBeVisible();
  await expect(page.getByText('Database size')).toBeVisible();
  await expect(page.getByText('853.1 MiB')).toBeVisible();
  await expect(page.getByText('Members').last()).toBeVisible();
});

test('deactivates and reactivates a member', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole({ reauthenticated: true });
  await harness.navigate('Members');

  await page.getByRole('button', { name: 'Deactivate ops-member' }).click();
  await expect(page.getByRole('dialog', { name: 'Deactivate member' })).toBeVisible();
  await page.getByLabel('Type DEACTIVATE ops-member to continue').fill('DEACTIVATE ops-member');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(page.getByRole('status')).toContainText('ops-member deactivated.');
  await expect(page.getByText('inactive').first()).toBeVisible();

  await page.getByRole('button', { name: 'Activate ops-member' }).click();
  await expect(page.getByRole('dialog', { name: 'Activate member' })).toBeVisible();
  await page.getByLabel('Type ACTIVATE ops-member to continue').fill('ACTIVATE ops-member');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(page.getByRole('status')).toContainText('ops-member activated.');
  await expect(page.getByRole('button', { name: 'Deactivate ops-member' })).toBeVisible();
});

test('shows inert task snapshots and diffs', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Tasks');

  await page.getByRole('button', { name: /Finish the nodem2 operations console/ }).click();
  await page.getByRole('button', { name: 'src/console/panel.tsx' }).click();

  await expect(page.locator('pre code')).toContainText(
    '<script>window.__ariadneCaptureExecuted = true</script>',
  );
  await expect(page.locator('pre code')).toContainText('payload:');

  await page.getByRole('button', { name: 'Diff' }).click();
  await expect(page.locator('pre code')).toContainText(
    '+  payload: "<script>window.__ariadneCaptureExecuted = true</script>",',
  );
  await expect
    .poll(() => page.evaluate(() => Boolean((window as Record<string, unknown>).__ariadneCaptureExecuted)))
    .toBe(false);
});

test('deletes a capture through confirmation and refreshes the timeline', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole({ reauthenticated: true });
  await harness.navigate('Tasks');

  await page.getByRole('button', { name: /Finish the nodem2 operations console/ }).click();
  await page.getByRole('button', { name: 'src/console/panel.tsx' }).click();

  const deleteTrigger = page.getByRole('button', { name: 'Delete capture capture-1' });
  await deleteTrigger.click();

  await expect(page.getByRole('dialog', { name: 'Delete file capture' })).toBeVisible();
  await page.getByLabel('Type DELETE capture-1 to continue').fill('DELETE capture-1');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(page.getByRole('status')).toContainText('Capture deleted.');
  await expect(page.getByRole('button', { name: 'src/console/panel.tsx' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'docs/notes.md' })).toBeFocused();
});

test('creates, verifies, downloads, and restores a backup', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Backups');

  await page.getByRole('button', { name: 'Create backup' }).click();
  await expect(page.getByText('Create verified database backup')).toBeVisible();
  await expect(page.getByText('Backup created.')).toBeVisible();

  const createdBackup = page.getByText(/ariadne-20260923T1015\d+Z\.dump/);
  await expect(createdBackup).toBeVisible();
  const createdFilename = await createdBackup.innerText();
  expect(createdFilename).toMatch(/ariadne-20260923T1015\d+Z\.dump/);

  let row = createdBackup.locator('xpath=ancestor::article[1]');
  await row.getByRole('button', { name: new RegExp(`Verify ${createdFilename}`) }).click();
  await expect(page.getByText('Backup verification completed.')).toBeVisible();

  row = page.getByText(createdFilename).locator('xpath=ancestor::article[1]');
  await expect(row.getByRole('button', { name: new RegExp(`Download ${createdFilename}`) })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await row.getByRole('button', { name: new RegExp(`Download ${createdFilename}`) }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/ariadne-20260923T1015/);

  await row.getByRole('button', { name: new RegExp(`Restore ${createdFilename}`) }).click();
  await expect(page.getByRole('dialog', { name: 'Restore verified backup' })).toBeVisible();
  await page.getByLabel(`Type RESTORE ${createdFilename} to continue`).fill(`RESTORE ${createdFilename}`);
  await page.getByLabel('Administrator password').fill('dashboard-password-123456');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(page.getByText('Backup restore completed.')).toBeVisible();
});

test('reconnects sync-server and postgres restarts after navigating away and back', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Services');

  await page.getByRole('button', { name: 'Restart sync-server' }).click();
  await page.getByLabel('Type RESTART sync-server to continue').fill('RESTART sync-server');
  await page.getByLabel('Administrator password').fill('dashboard-password-123456');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await harness.navigate('Overview');
  await harness.navigate('Services');
  await expect(page.getByText('HTTP listener healthy after restart.')).toBeVisible();

  await page.getByRole('button', { name: 'Restart postgres' }).click();
  await page.getByLabel('Type RESTART postgres to continue').fill('RESTART postgres');
  if (await page.getByLabel('Administrator password').count()) {
    await page.getByLabel('Administrator password').fill('dashboard-password-123456');
  }
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await harness.navigate('Overview');
  await harness.navigate('Services');
  await expect(page.getByText('Primary database healthy after restart.')).toBeVisible();
});

test('deploys and rolls back using server-returned revisions', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Deployments');
  const currentRevision = page.locator('.deployment-summary .status-timestamp').filter({ hasText: 'Current' });
  const rollbackTarget = page
    .locator('.deployment-summary .status-timestamp')
    .filter({ hasText: 'Rollback target' });

  await page.getByText('feat: finish dashboard browser gate').click();
  await page.getByRole('button', { name: 'Deploy selected revision' }).click();
  await page.getByLabel(`Type DEPLOY ${'a'.repeat(40)} to continue`).fill(`DEPLOY ${'a'.repeat(40)}`);
  await page.getByLabel('Administrator password').fill('dashboard-password-123456');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(page.getByText('Deployment completed.')).toBeVisible();
  await expect(currentRevision.getByText('a'.repeat(40))).toBeVisible();
  await expect(rollbackTarget.getByText('f'.repeat(40))).toBeVisible();

  await page.getByRole('button', { name: 'Rollback to previous revision' }).click();
  await page.getByLabel(`Type ROLLBACK ${'f'.repeat(40)} to continue`).fill(`ROLLBACK ${'f'.repeat(40)}`);
  if (await page.getByLabel('Administrator password').count()) {
    await page.getByLabel('Administrator password').fill('dashboard-password-123456');
  }
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(currentRevision.getByText('f'.repeat(40))).toBeVisible();
  await expect(rollbackTarget.getByText('a'.repeat(40))).toBeVisible();
});

test('filters and paginates logs and audit events', async ({ harness, page }) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Logs');

  await page.getByLabel('Source').selectOption('deployment');
  await expect(page.getByText('deployment warning: rotation pending')).toBeVisible();

  const initialLogCount = await page.locator('.log-row').count();
  await page.getByRole('button', { name: 'Load older lines' }).click();
  await expect.poll(async () => page.locator('.log-row').count()).toBeGreaterThan(initialLogCount);
  await page.getByLabel('Filter loaded lines').fill('rotation');
  await expect(page.getByText('deployment warning: rotation pending')).toBeVisible();

  await harness.navigate('Audit');
  await page.getByLabel('Action').fill('admin_operation.state_changed');
  await page.getByLabel('Outcome').fill('failed');
  await page.getByRole('button', { name: 'Apply filters' }).click();

  await expect(page.getByText('Operation op-audit-60')).toBeVisible();
  await page.getByRole('button', { name: 'Load older events' }).click();
  await expect(page.getByText('Operation op-audit-58')).toBeVisible();

  await page.getByRole('link', { name: 'Operation op-audit-60' }).click();
  await expect(page.getByRole('region', { name: 'Operation progress' })).toBeFocused();
});

test('expires the session and then requires password reauthentication for a protected mutation', async ({
  harness,
  page,
}) => {
  await harness.openAuthenticatedConsole();
  await harness.navigate('Members');

  harness.expireSession();
  await page.getByRole('button', { name: 'Refresh members' }).click();

  await expect(page.getByRole('heading', { name: 'Command your Ariadne cloud' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Session expired. Sign in again.');

  await harness.login();
  await harness.navigate('Members');
  await page.getByRole('button', { name: 'Deactivate ops-member' }).click();

  await expect(page.getByLabel('Administrator password')).toBeVisible();
  await page.getByLabel('Type DEACTIVATE ops-member to continue').fill('DEACTIVATE ops-member');
  await page.getByLabel('Administrator password').fill('dashboard-password-123456');
  await page.getByRole('button', { name: 'Continue operation' }).click();

  await expect(page.getByRole('status')).toContainText('ops-member deactivated.');
});
