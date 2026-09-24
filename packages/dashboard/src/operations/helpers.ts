import type { AdminOperation } from '../api/types';

export function hasFreshReauthentication(value: string | null | undefined): boolean {
  return typeof value === 'string' && Date.parse(value) > Date.now();
}

export function isOperationActive(operation: AdminOperation | null | undefined): boolean {
  return operation?.state === 'queued' || operation?.state === 'running';
}

export function formatAbsoluteTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ') + ' UTC';
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  }
  return `${bytes} B`;
}

export function shortenSha(value: string): string {
  return value.slice(0, 12);
}
