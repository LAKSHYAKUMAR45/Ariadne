import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmationDialog } from './ConfirmationDialog';

describe('ConfirmationDialog', () => {
  it('moves focus into the dialog and returns it to the trigger on close', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    function Host() {
      const [open, setOpen] = useState(false);

      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>Open destructive action</button>
          {open ? (
            <ConfirmationDialog
              request={{
                title: 'Delete capture',
                impact: 'This removes the encrypted capture and its files.',
                expectedConfirmation: 'DELETE capture-1',
                confirmationLabel: 'Type DELETE capture-1 to continue',
                requiresReauthentication: false,
              }}
              busy={false}
              error={null}
              onCancel={() => {
                onCancel();
                setOpen(false);
              }}
              onConfirm={vi.fn()}
            />
          ) : null}
        </div>
      );
    }

    render(<Host />);

    const trigger = screen.getByRole('button', { name: 'Open destructive action' });
    await user.click(trigger);

    expect(await screen.findByRole('dialog', { name: 'Delete capture' })).toBeVisible();
    expect(screen.getByLabelText('Type DELETE capture-1 to continue')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it('requires an exact confirmation match and password before confirming a protected action', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ConfirmationDialog
        request={{
          title: 'Restore backup',
          impact: 'The database will be replaced by the selected verified backup.',
          expectedConfirmation: 'RESTORE ariadne-20260923T094609Z.dump',
          confirmationLabel: 'Type the restore phrase exactly',
          requiresReauthentication: true,
        }}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const submit = screen.getByRole('button', { name: 'Continue operation' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Type the restore phrase exactly'), 'restore ariadne');
    await user.type(screen.getByLabelText('Administrator password'), 'password-123');
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText('Type the restore phrase exactly'));
    await user.type(
      screen.getByLabelText('Type the restore phrase exactly'),
      'RESTORE ariadne-20260923T094609Z.dump',
    );
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(onConfirm).toHaveBeenCalledWith({
      confirmation: 'RESTORE ariadne-20260923T094609Z.dump',
      password: 'password-123',
    });
  });
});
