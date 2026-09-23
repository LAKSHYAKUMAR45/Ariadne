import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError, isAbortError } from '../api/client';
import { isMemberMutationResponse, isMembersResponse } from '../api/guards';
import type { ConfirmationRequest, TeamMember } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../components/AsyncState';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { StatusLabel } from '../components/StatusLabel';

interface PendingMutation {
  member: TeamMember;
  nextActive: boolean;
  request: ConfirmationRequest;
}

interface LoadMembersOptions {
  propagateError?: boolean;
}

function formatAbsoluteDate(value: string): string {
  return value.slice(0, 16).replace('T', ' ') + ' UTC';
}

function confirmationForMember(member: TeamMember, nextActive: boolean, requiresReauthentication: boolean): ConfirmationRequest {
  const command = `${nextActive ? 'ACTIVATE' : 'DEACTIVATE'} ${member.username}`;

  return {
    title: nextActive ? 'Activate member' : 'Deactivate member',
    impact: nextActive
      ? `Restore ${member.username}'s team access after fresh administrator confirmation.`
      : `Suspend ${member.username}'s team access after fresh administrator confirmation.`,
    expectedConfirmation: command,
    confirmationLabel: `Type ${command} to continue`,
    requiresReauthentication,
  };
}

function hasFreshReauthentication(value: string | null): boolean {
  return value !== null && Date.parse(value) > Date.now();
}

export function MembersPage() {
  const { api, reauthenticate, session } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const membersRef = useRef<TeamMember[]>([]);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const loadMembers = useCallback(async ({ propagateError = false }: LoadMembersOptions = {}): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const hasExistingData = membersRef.current.length > 0;

    if (!hasExistingData) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const response = await api.get('/api/v1/admin/members', isMembersResponse, controller.signal);
      if (controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      setMembers(response.members);
      setLoadError(null);
    } catch (loadErrorValue: unknown) {
      if (isAbortError(loadErrorValue) || controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      const nextError =
        loadErrorValue instanceof Error ? loadErrorValue : new Error('Unable to load members.');
      setLoadError(nextError.message);
      if (!hasExistingData) {
        setMembers([]);
      }
      if (propagateError) {
        throw nextError;
      }
    } finally {
      if (controllerRef.current === controller) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadMembers();
    return () => controllerRef.current?.abort();
  }, [loadMembers]);

  const counts = useMemo(
    () =>
      members.reduce(
        (summary, member) => ({
          total: summary.total + 1,
          active: summary.active + (member.active ? 1 : 0),
          inactive: summary.inactive + (member.active ? 0 : 1),
        }),
        { total: 0, active: 0, inactive: 0 },
      ),
    [members],
  );

  async function confirmMutation(input: { confirmation: string; password?: string }): Promise<void> {
    if (!pending) {
      return;
    }

    const currentPending = pending;
    let mutationApplied = false;
    setBusy(true);
    setDialogError(null);
    setLoadError(null);
    setMessage(null);

    try {
      if (currentPending.request.requiresReauthentication) {
        await reauthenticate(input.password ?? '');
      }

      await api.mutate(
        'PATCH',
        `/api/v1/admin/members/${encodeURIComponent(currentPending.member.userId)}`,
        {
          active: currentPending.nextActive,
          confirmation: input.confirmation,
        },
        isMemberMutationResponse,
      );

      mutationApplied = true;
      setPending(null);
      await loadMembers({ propagateError: true });
      setMessage(
        `${currentPending.member.username} ${currentPending.nextActive ? 'activated' : 'deactivated'}.`,
      );
    } catch (mutationError: unknown) {
      if (mutationError instanceof AdminApiError && mutationError.code === 'reauthentication_required') {
        setPending((current) =>
          current
            ? {
                ...current,
                request: {
                  ...current.request,
                  requiresReauthentication: true,
                },
              }
            : current,
        );
      }
      if (!mutationApplied) {
        setDialogError(
          mutationError instanceof Error ? mutationError.message : 'The member change could not be completed.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Access</p>
          <h1>Members</h1>
          <p>Activate or deactivate team members with exact confirmation and fresh reauthentication.</p>
        </div>
        <button className="quiet-action" type="button" disabled={refreshing} onClick={() => void loadMembers()}>
          {refreshing ? 'Refreshing…' : 'Refresh members'}
        </button>
      </header>

      {message ? <div className="notice notice--success" role="status">{message}</div> : null}

      <section className="priority-strip" aria-label="Member counts">
        <div>
          <span>Members</span>
          <strong>{counts.total}</strong>
        </div>
        <div>
          <span>Active</span>
          <strong>{counts.active}</strong>
        </div>
        <div>
          <span>Inactive</span>
          <strong>{counts.inactive}</strong>
        </div>
      </section>

      <section className="panel data-panel">
        <div className="table-heading">
          <strong>Team access</strong>
          <span>{members.length} rows</span>
        </div>
        <AsyncState
          loading={loading && members.length === 0}
          empty={members.length === 0}
          error={members.length === 0 ? loadError : null}
          partialError={members.length > 0 ? loadError : null}
          loadingLabel="Loading members"
          emptyTitle="No members found"
          emptyMessage="Team memberships will appear here once the singleton team exists."
        >
          <div className="member-table__wrap">
            <table className="member-table">
              <thead>
                <tr>
                  <th scope="col">Username</th>
                  <th scope="col">Role</th>
                  <th scope="col">State</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const nextActive = !member.active;
                  return (
                    <tr key={member.userId}>
                      <td data-label="Username">
                        <strong className="member-name">{member.username}</strong>
                      </td>
                      <td data-label="Role">
                        <span className="member-role">{member.role}</span>
                      </td>
                      <td data-label="State">
                        <StatusLabel status={member.active ? 'active' : 'inactive'} />
                      </td>
                      <td data-label="Joined">
                        <time dateTime={member.createdAt}>{formatAbsoluteDate(member.createdAt)}</time>
                      </td>
                      <td data-label="Action">
                        {member.immutable ? (
                          <span className="member-static">Immutable</span>
                        ) : (
                          <button
                            className="quiet-action row-action"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setDialogError(null);
                              setMessage(null);
                              setPending({
                                member,
                                nextActive,
                                request: confirmationForMember(
                                  member,
                                  nextActive,
                                  !hasFreshReauthentication(session?.reauthenticatedUntil ?? null),
                                ),
                              });
                            }}
                          >
                            {member.active ? `Deactivate ${member.username}` : `Activate ${member.username}`}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AsyncState>
      </section>

      {pending ? (
        <ConfirmationDialog
          request={pending.request}
          busy={busy}
          error={dialogError}
          onCancel={() => {
            if (!busy) {
              setPending(null);
              setDialogError(null);
            }
          }}
          onConfirm={confirmMutation}
        />
      ) : null}
    </div>
  );
}
