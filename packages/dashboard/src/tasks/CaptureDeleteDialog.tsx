import type { CapturedFileMetadata } from '../api/types';
import { ConfirmationDialog } from '../components/ConfirmationDialog';

interface CaptureDeleteDialogProps {
  captureId: string;
  files: CapturedFileMetadata[];
  requiresReauthentication: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: { confirmation: string; password?: string }) => Promise<void>;
}

export function CaptureDeleteDialog({
  captureId,
  files,
  requiresReauthentication,
  busy,
  error,
  onCancel,
  onConfirm,
}: CaptureDeleteDialogProps) {
  const confirmation = `DELETE ${captureId}`;

  return (
    <ConfirmationDialog
      request={{
        title: 'Delete file capture',
        impact: 'Remove this encrypted capture and every affected file from the task timeline.',
        expectedConfirmation: confirmation,
        confirmationLabel: `Type ${confirmation} to continue`,
        requiresReauthentication,
      }}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="capture-delete-preview">
        <p className="capture-delete-preview__title">Affected paths</p>
        <ul className="capture-delete-preview__list">
          {files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>
            </li>
          ))}
        </ul>
      </div>
    </ConfirmationDialog>
  );
}
