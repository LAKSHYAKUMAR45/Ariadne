import { timingSafeEqual } from 'node:crypto';

type RestartableService = 'sync-server' | 'postgres';

function confirmationEquals(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') {
    return false;
  }
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}

export const confirmationFor = {
  serviceRestart(service: RestartableService): string {
    return `RESTART ${service}`;
  },
  restore(backupName: string): string {
    return `RESTORE ${backupName}`;
  },
  deploy(revision: string): string {
    return `DEPLOY ${revision}`;
  },
  rollback(revision: string): string {
    return `ROLLBACK ${revision}`;
  },
  captureDelete(captureId: string): string {
    return `DELETE ${captureId}`;
  },
  memberState(username: string, active: boolean): string {
    return `${active ? 'ACTIVATE' : 'DEACTIVATE'} ${username}`;
  },
} as const;

export function requireConfirmation(expected: string, provided: unknown): void {
  if (!confirmationEquals(expected, provided)) {
    throw new Error('confirmation_mismatch');
  }
}
