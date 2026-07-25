'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  FormField,
  Input,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@ventia/ui';
import { ApiError, apiFetch } from '../../../lib/api';
import { errorMessage, fieldErrors } from '../../../lib/errors';
import { formatDateCO } from '../../../lib/format';
import { inviteStatus } from '../../../lib/invite-status';

type Role = 'owner' | 'staff';

interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

interface Invite {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
}

interface StaffListResponse {
  members: Member[];
  invites: Invite[];
}

interface InviteCreated {
  id: string;
  email: string;
  expiresAt: string;
}

interface PlanLimitDetails {
  limit?: number;
}

function isPlanLimitDetails(value: unknown): value is PlanLimitDetails {
  return typeof value === 'object' && value !== null;
}

/** Owner-only route: this page is hidden from staff in the nav (lib/nav.ts),
 * but the real enforcement boundary is server-side (`@Roles('owner')` on
 * StaffController) — a staff session hitting `/equipo` directly still gets
 * a 403 FORBIDDEN_ROLE from `GET /v1/admin/staff`, which `load`'s catch
 * below surfaces via `errorMessage` in the same `loadError` alert as any
 * other load failure. */
const ROLE_LABELS: Record<Role, string> = {
  owner: 'Propietario',
  staff: 'Personal',
};

/** `PLAN_LIMIT_EXCEEDED` on `POST /v1/admin/staff/invites` carries the
 * tenant's seat limit in `details.limit` (see staff.service.ts#createInvite)
 * — surfaced as a specific "seat limit reached, upgrade your plan" message
 * rather than `errorMessage`'s generic plan-limit copy, per the binding
 * contract's "upgrade Alert (seat limit)" requirement. */
function seatLimitMessage(e: ApiError): string {
  const limit = isPlanLimitDetails(e.details) ? e.details.limit : undefined;
  if (typeof limit !== 'number') return errorMessage(e);
  return `Alcanzaste el límite de ${limit} puesto${limit === 1 ? '' : 's'} de personal de tu plan. Mejora tu plan para invitar a más personas.`;
}

/** Equipo page: members table + pending-invites table, an invite dialog, and
 * confirm dialogs for removing a member / revoking an invite — same
 * three-piece pattern as categorias/page.tsx (local form state, a submit
 * handler that clears previous errors then calls the API, and either
 * updates local state in place or surfaces the error). */
export default function EquipoPage() {
  const [data, setData] = useState<StaffListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<StaffListResponse>('/v1/admin/staff');
      setData(result);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // --- invite dialog ---
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteFieldErrors, setInviteFieldErrors] = useState<Record<string, string>>({});
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState<InviteCreated | null>(null);

  function openInvite() {
    setInviteEmail('');
    setInviteError(null);
    setInviteFieldErrors({});
    setInviteSuccess(null);
    setInviteOpen(true);
  }

  function closeInvite() {
    setInviteOpen(false);
    setInviteSuccess(null);
  }

  async function handleInviteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteError(null);
    setInviteFieldErrors({});
    setInviteSubmitting(true);
    try {
      const created = await apiFetch<InviteCreated>('/v1/admin/staff/invites', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      setData((prev) =>
        prev ? { ...prev, invites: [...prev.invites, { ...created, createdAt: new Date().toISOString() }] } : prev,
      );
      setInviteSuccess(created);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setInviteFieldErrors(fieldErrors(e));
        else if (e.code === 'PLAN_LIMIT_EXCEEDED') setInviteError(seatLimitMessage(e));
        else setInviteError(errorMessage(e));
      } else {
        setInviteError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setInviteSubmitting(false);
    }
  }

  // --- remove-member confirm dialog ---
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);

  function openRemove(member: Member) {
    setRemoveTarget(member);
    setRemoveError(null);
  }

  async function handleRemoveConfirm() {
    if (!removeTarget) return;
    setRemoveError(null);
    setRemoveSubmitting(true);
    try {
      await apiFetch<void>(`/v1/admin/staff/${removeTarget.userId}`, { method: 'DELETE' });
      setData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== removeTarget.userId) } : prev,
      );
      setRemoveTarget(null);
    } catch (e) {
      // Covers CANNOT_REMOVE_OWNER (the owner's own row never renders this
      // dialog, but a stale row from a concurrent tab could still trigger
      // it) alongside NOT_FOUND and any other failure — all via the same
      // generic es-CO mapping.
      setRemoveError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setRemoveSubmitting(false);
    }
  }

  // --- revoke-invite confirm dialog ---
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSubmitting, setRevokeSubmitting] = useState(false);

  function openRevoke(invite: Invite) {
    setRevokeTarget(invite);
    setRevokeError(null);
  }

  async function handleRevokeConfirm() {
    if (!revokeTarget) return;
    setRevokeError(null);
    setRevokeSubmitting(true);
    try {
      await apiFetch<void>(`/v1/admin/staff/invites/${revokeTarget.id}`, { method: 'DELETE' });
      setData((prev) => (prev ? { ...prev, invites: prev.invites.filter((i) => i.id !== revokeTarget.id) } : prev));
      setRevokeTarget(null);
    } catch (e) {
      setRevokeError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setRevokeSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="w-full max-w-3xl">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Equipo</CardTitle>
          <Button onClick={openInvite}>Invitar</Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cargando equipo…
            </div>
          ) : loadError ? (
            <div className="flex flex-col gap-3">
              <Alert variant="error">{loadError}</Alert>
              <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
                Reintentar
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-foreground">Miembros</h3>
                {!data || data.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aún no hay miembros en el equipo.</p>
                ) : (
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Correo</Th>
                        <Th>Nombre</Th>
                        <Th>Rol</Th>
                        <Th>Fecha</Th>
                        <Th>
                          <span className="sr-only">Acciones</span>
                        </Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {data.members.map((member) => (
                        <Tr key={member.userId}>
                          <Td>{member.email}</Td>
                          <Td>{member.name || '—'}</Td>
                          <Td>{ROLE_LABELS[member.role]}</Td>
                          <Td>{formatDateCO(member.createdAt)}</Td>
                          <Td className="flex justify-end">
                            {member.role !== 'owner' ? (
                              <Button variant="destructive" size="sm" onClick={() => openRemove(member)}>
                                Eliminar
                              </Button>
                            ) : null}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                )}
              </div>

              <div className="flex flex-col gap-3 border-t border-border pt-6">
                <h3 className="text-sm font-semibold text-foreground">Invitaciones pendientes</h3>
                {!data || data.invites.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No hay invitaciones pendientes.</p>
                ) : (
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Correo</Th>
                        <Th>Expira</Th>
                        <Th>Estado</Th>
                        <Th>
                          <span className="sr-only">Acciones</span>
                        </Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {data.invites.map((invite) => {
                        const status = inviteStatus(invite);
                        return (
                          <Tr key={invite.id}>
                            <Td>{invite.email}</Td>
                            <Td>{formatDateCO(invite.expiresAt)}</Td>
                            <Td>
                              <Badge variant={status === 'expirada' ? 'destructive' : 'secondary'}>
                                {status === 'expirada' ? 'Expirada' : 'Pendiente'}
                              </Badge>
                            </Td>
                            <Td className="flex justify-end">
                              <Button variant="destructive" size="sm" onClick={() => openRevoke(invite)}>
                                Revocar
                              </Button>
                            </Td>
                          </Tr>
                        );
                      })}
                    </Tbody>
                  </Table>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onClose={closeInvite}>
        {inviteSuccess ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-foreground">Invitación enviada</h2>
            <Alert variant="success">Enviamos un correo con el enlace de invitación a {inviteSuccess.email}.</Alert>
            <p className="text-xs text-muted-foreground">
              En este entorno de desarrollo no se envían correos reales: el enlace de invitación aparece impreso en
              la consola del servidor de la API.
            </p>
            <div className="flex justify-end">
              <Button onClick={closeInvite}>Cerrar</Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleInviteSubmit}>
            <h2 className="text-lg font-semibold text-foreground">Invitar a alguien al equipo</h2>
            {inviteError ? <Alert variant="error">{inviteError}</Alert> : null}
            <FormField label="Correo" htmlFor="invite-email" error={inviteFieldErrors.email}>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                required
                autoFocus
              />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeInvite}>
                Cancelar
              </Button>
              <Button type="submit" disabled={inviteSubmitting}>
                {inviteSubmitting ? 'Enviando…' : 'Enviar invitación'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={removeTarget !== null} onClose={() => setRemoveTarget(null)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Eliminar miembro</h2>
          <p className="text-sm text-foreground">
            ¿Eliminar a <span className="font-medium">{removeTarget?.email}</span> del equipo? Perderá acceso al
            panel de administración de inmediato.
          </p>
          {removeError ? <Alert variant="error">{removeError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={removeSubmitting} onClick={() => void handleRemoveConfirm()}>
              {removeSubmitting ? 'Eliminando…' : 'Eliminar'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={revokeTarget !== null} onClose={() => setRevokeTarget(null)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Revocar invitación</h2>
          <p className="text-sm text-foreground">
            ¿Revocar la invitación enviada a <span className="font-medium">{revokeTarget?.email}</span>? El enlace
            dejará de funcionar.
          </p>
          {revokeError ? <Alert variant="error">{revokeError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevokeTarget(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={revokeSubmitting} onClick={() => void handleRevokeConfirm()}>
              {revokeSubmitting ? 'Revocando…' : 'Revocar'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
