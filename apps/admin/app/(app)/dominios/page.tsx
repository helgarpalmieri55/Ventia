'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, FormField, Input, Spinner } from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import {
  DOMAIN_STATE_BADGE,
  DOMAIN_STATE_LABEL,
  INVALID_DOMAIN_MESSAGE,
  addDomain,
  addDomainFieldError,
  canBecomePrimary,
  domainState,
  domainStateExplanation,
  isPlatformDomain,
  listDomains,
  normalizeDomainInput,
  platformRootDomain,
  primaryChangeConsequences,
  removeDomain,
  setPrimaryDomain,
  storefrontUrl,
  verificationHelp,
  verificationRecord,
  verifyDomain,
  type DnsRecord,
  type DomainState,
  type DomainsResponse,
  type TenantDomain,
} from '../../../lib/domains-api';

/**
 * Dominios — the merchant's own address for their store (docs/SPEC.md §11 P6).
 *
 * Owner-only, mirroring `@Roles('owner')` on `CustomDomainsController`: the
 * whole resource is owner-only there, not just its writes, so a staff session
 * that navigates here directly gets 403 FORBIDDEN_ROLE from
 * `GET /v1/admin/domains` and `load`'s catch surfaces it in the same alert as
 * any other load failure (same posture as `equipo/page.tsx`).
 *
 * The page answers three different merchants in one screen:
 *
 *  1. **The one who bought nothing.** Their store already has an address and
 *     they have nothing to do. That is the FIRST thing on the page, stated as a
 *     working address with a link to open it — not hidden behind an empty
 *     state that reads like something is missing.
 *  2. **The one on `basico`.** `TenantLimits.customDomain` is false for that
 *     plan, so the connect form is replaced by an upgrade prompt BEFORE any DNS
 *     work is described. Showing the form and letting `POST` answer 402 would
 *     cost them an afternoon in their registrar's control panel to learn
 *     something we knew before the page rendered.
 *  3. **The one setting up `mitienda.com`.** Everything they need is on screen
 *     at once: the exact record, the two copy buttons, what "it takes a while"
 *     really means, and — once verified — the action that makes their customers
 *     actually see that address.
 */
export default function DominiosPage() {
  const [data, setData] = useState<DomainsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await listDomains());
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The platform's own zone, derived (the API does not send it — see
   * `platformRootDomain`). `window.location.hostname` is read inside the
   * memo rather than during module evaluation: this component is still
   * server-rendered once, and on that pass `data` is null, so the only markup
   * the server produces is the spinner — identical on both sides, no
   * hydration mismatch.
   */
  const platformRoot = useMemo(
    () => platformRootDomain(data?.items ?? [], typeof window === 'undefined' ? null : window.location.hostname),
    [data],
  );

  const stateOf = useCallback(
    (domain: TenantDomain): DomainState =>
      domainState(domain, { customDomainEnabled: data?.customDomainEnabled ?? false, platformRoot }),
    [data?.customDomainEnabled, platformRoot],
  );

  /** Replaces one row in place, keeping list order stable — a row that jumped
   * position the moment it verified would move the buttons out from under the
   * merchant's cursor. */
  const patchDomain = useCallback((id: string, patch: Partial<TenantDomain>) => {
    setData((prev) =>
      prev ? { ...prev, items: prev.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) } : prev,
    );
  }, []);

  const dropDomain = useCallback((id: string) => {
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((item) => item.id !== id) } : prev));
  }, []);

  /** Promotion is the one action whose effect is not local to its row: the
   * previous primary has to lose the badge at the same instant. */
  const markPrimary = useCallback((id: string) => {
    setData((prev) =>
      prev ? { ...prev, items: prev.items.map((item) => ({ ...item, isPrimary: item.id === id })) } : prev,
    );
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando tus dominios…
      </p>
    );
  }

  if (loadError || !data) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="error">{loadError ?? 'Ocurrió un error inesperado. Intenta de nuevo.'}</Alert>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const platformDomains = data.items.filter((item) => stateOf(item) === 'platform');
  const customDomains = data.items.filter((item) => stateOf(item) !== 'platform');
  const primary = data.items.find((item) => item.isPrimary) ?? null;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>La dirección de tu tienda</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {platformDomains.length === 0 ? (
            // Only reachable if the platform subdomain was removed, or if the
            // zone could not be derived. Says what we know instead of
            // pretending the section is empty on purpose.
            <p className="text-sm text-muted-foreground">
              No pudimos identificar la dirección que te dimos al crear la tienda. Si tu tienda no abre por ninguna
              de las direcciones de abajo, escríbenos.
            </p>
          ) : (
            platformDomains.map((domain) => (
              <DomainCard
                key={domain.id}
                domain={domain}
                state="platform"
                primaryDomain={primary?.domain ?? null}
                verificationHost={data.verificationHost}
                onPatched={patchDomain}
                onPromoted={markPrimary}
                onRemoved={dropDomain}
              />
            ))
          )}
          <p className="text-sm text-muted-foreground">
            Esta dirección es tuya desde que creaste la tienda, funciona con candado de seguridad (HTTPS) y no
            necesitas configurar nada para mantenerla. Conectar un dominio propio es opcional: sirve si ya compraste
            uno y quieres que tus clientes vean ese nombre.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tu propio dominio</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {customDomains.length > 0 ? (
            <div className="flex flex-col gap-4">
              {customDomains.map((domain) => (
                <DomainCard
                  key={domain.id}
                  domain={domain}
                  state={stateOf(domain)}
                  primaryDomain={primary?.domain ?? null}
                  verificationHost={data.verificationHost}
                  onPatched={patchDomain}
                  onPromoted={markPrimary}
                  onRemoved={dropDomain}
                />
              ))}
            </div>
          ) : null}

          {data.customDomainEnabled ? (
            <AddDomainForm
              existing={data.items}
              platformRoot={platformRoot}
              onAdded={(added) => {
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        items: [...prev.items, { ...added, isPrimary: false, verified: false }],
                      }
                    : prev,
                );
              }}
              onPlanRefused={() => setData((prev) => (prev ? { ...prev, customDomainEnabled: false } : prev))}
            />
          ) : (
            <UpgradePrompt hasDomains={customDomains.length > 0} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Shown INSTEAD of the connect form when `TenantLimits.customDomain` is false
 * (`basico` — see `PLANS` in `@ventia/core`). Same shape as the WhatsApp tab's
 * upgrade prompt, including the deliberate absence of an "upgrade" link: plans
 * are changed by the platform operator, and a button that goes nowhere is
 * worse than a sentence that says who to ask.
 */
function UpgradePrompt({ hasDomains }: { hasDomains: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Conectar un dominio propio</h3>
      <Alert variant="warning">
        <p>
          Tu plan actual no incluye dominio propio, así que todavía no puedes conectar uno. Escríbenos para mejorar
          tu plan y te ayudamos a conectarlo.
        </p>
        <p className="mt-2">
          Te lo decimos antes de que toques nada: cambiar el DNS de un dominio sin tener el plan no sirve de nada,
          porque no podemos emitirle el certificado de seguridad hasta que el plan lo incluya.
        </p>
        {hasDomains ? (
          <p className="mt-2">
            Los dominios que ya agregaste siguen en la lista, pero tu tienda no responde en ellos mientras tu plan no
            los incluya.
          </p>
        ) : null}
      </Alert>
      <p className="text-sm text-muted-foreground">
        Mientras tanto tu tienda sigue funcionando con normalidad en la dirección de arriba.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One domain                                                                 */
/* -------------------------------------------------------------------------- */

function DomainCard({
  domain,
  state,
  primaryDomain,
  verificationHost,
  onPatched,
  onPromoted,
  onRemoved,
}: {
  domain: TenantDomain;
  state: DomainState;
  primaryDomain: string | null;
  verificationHost: string;
  onPatched: (id: string, patch: Partial<TenantDomain>) => void;
  onPromoted: (id: string) => void;
  onRemoved: (id: string) => void;
}) {
  const record = verificationRecord(domain, verificationHost);

  // --- verify ---
  const [verifying, setVerifying] = useState(false);
  /** Consecutive failed checks in THIS session. Drives how much detail the
   * "not yet" answer carries — see `verificationHelp`. */
  const [failures, setFailures] = useState(0);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  /** Only for the check that just happened in this session — the row's own
   * badge is what tells a merchant who comes back tomorrow. */
  const [justVerified, setJustVerified] = useState(false);

  async function handleVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await verifyDomain(domain.id);
      if (result.verified) {
        setFailures(0);
        setJustVerified(true);
        onPatched(domain.id, { verified: true });
      } else {
        setFailures((n) => n + 1);
      }
    } catch (e) {
      setVerifyError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setVerifying(false);
    }
  }

  // --- make primary ---
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  async function handlePromote() {
    setPromoting(true);
    setPromoteError(null);
    try {
      await setPrimaryDomain(domain.id);
      onPromoted(domain.id);
      setPromoteOpen(false);
    } catch (e) {
      // DOMAIN_NOT_VERIFIED lands here for a stale tab (the button is only
      // rendered for verified domains) and reads as "verify it first", not as
      // a failure — see lib/errors.ts.
      setPromoteError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setPromoting(false);
    }
  }

  // --- remove ---
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleRemove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeDomain(domain.id);
      onRemoved(domain.id);
      setRemoveOpen(false);
    } catch (e) {
      setRemoveError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setRemoving(false);
    }
  }

  const help = failures > 0 ? verificationHelp(failures, record) : null;

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-all font-mono text-sm font-medium text-foreground">{domain.domain}</span>
          {domain.isPrimary ? <Badge>Principal</Badge> : null}
          <Badge variant={DOMAIN_STATE_BADGE[state]}>{DOMAIN_STATE_LABEL[state]}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state === 'platform' || state === 'active' ? (
            <a
              href={storefrontUrl(domain.domain)}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary underline"
            >
              Abrir tienda
            </a>
          ) : null}
          {state === 'pending' ? (
            <Button size="sm" disabled={verifying} onClick={() => void handleVerify()}>
              {verifying ? 'Revisando…' : 'Verificar'}
            </Button>
          ) : null}
          {canBecomePrimary(domain, state) ? (
            <Button variant="secondary" size="sm" onClick={() => setPromoteOpen(true)}>
              Usar como principal
            </Button>
          ) : null}
          {/* Never for the address we gave them: `DELETE` accepts it, and a
              store on `basico` that removed it could not add it back (POST is
              plan-gated), so it would be left with no address at all. */}
          {state === 'platform' ? null : (
            <Button variant="destructive" size="sm" onClick={() => setRemoveOpen(true)}>
              Eliminar
            </Button>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{domainStateExplanation(state)}</p>

      {domain.isPrimary ? (
        <p className="text-sm text-muted-foreground">
          Es la dirección que ven tus clientes: los enlaces que el asistente envía por WhatsApp y la dirección que
          aparece en tu política de tratamiento de datos usan este dominio.
        </p>
      ) : null}

      {state === 'pending' ? (
        <PendingSetup record={record} primaryDomain={primaryDomain} help={help} verifyError={verifyError} />
      ) : null}

      {justVerified && state === 'active' ? (
        <Alert variant="success">
          Listo, verificamos {domain.domain}. La primera vez que alguien la abra puede tardar unos segundos mientras
          emitimos el certificado de seguridad; después carga normal.
        </Alert>
      ) : null}

      {state === 'active' && !domain.isPrimary ? (
        <Alert variant="info">
          Este dominio ya funciona, pero tus clientes todavía ven {primaryDomain ?? 'otra dirección'} en los enlaces
          que envía el asistente. Pulsa &quot;Usar como principal&quot; si quieres que vean este.
        </Alert>
      ) : null}

      <Dialog open={promoteOpen} onClose={() => setPromoteOpen(false)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Usar {domain.domain} como dirección principal</h2>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-foreground">
            {primaryChangeConsequences(domain.domain, primaryDomain).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {promoteError ? <Alert variant="error">{promoteError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPromoteOpen(false)}>
              Cancelar
            </Button>
            <Button disabled={promoting} onClick={() => void handlePromote()}>
              {promoting ? 'Guardando…' : 'Usar como principal'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={removeOpen} onClose={() => setRemoveOpen(false)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Eliminar {domain.domain}</h2>
          <p className="text-sm text-foreground">
            {state === 'pending'
              ? 'Todavía no habíamos verificado este dominio, así que tu tienda no responde en él. Puedes volver a agregarlo cuando quieras.'
              : 'Tu tienda deja de responder en esta dirección: quien la escriba verá un error, no tu tienda.'}
          </p>
          {domain.isPrimary ? (
            <Alert variant="warning">
              Es tu dirección principal. Si la eliminas, los enlaces nuevos que envíe el asistente y la dirección de
              tu política de datos van a pasar a otra de tus direcciones. Si quieres cambiar de dominio, es mejor
              marcar el otro como principal primero.
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Si vuelves a conectarlo más tarde te mostramos otra vez el mismo registro TXT; si nunca lo borraste de tu
            proveedor de DNS, la verificación es inmediata.
          </p>
          {removeError ? <Alert variant="error">{removeError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoveOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={removing} onClick={() => void handleRemove()}>
              {removing ? 'Eliminando…' : 'Eliminar dominio'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * Everything a merchant needs while a domain is waiting on DNS.
 *
 * The record is shown as its two fields separately (name and value) rather
 * than as prose, and the "name" field shows the host-only form first: nearly
 * every registrar's panel appends the zone itself, so pasting the full name
 * produces `_ventia-verify.mitienda.com.mitienda.com` — the single most common
 * reason a verification never completes.
 */
function PendingSetup({
  record,
  primaryDomain,
  help,
  verifyError,
}: {
  record: DnsRecord;
  primaryDomain: string | null;
  help: ReturnType<typeof verificationHelp> | null;
  verifyError: string | null;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-muted/40 p-3">
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium text-foreground">1. Publica este registro en tu proveedor de dominio</h4>
        <p className="text-xs text-muted-foreground">
          Entra donde compraste el dominio (GoDaddy, Namecheap, Cloudflare, tu proveedor de hosting…), busca la zona
          DNS y crea un registro nuevo con estos tres datos.
        </p>
      </div>

      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-foreground">Tipo</dt>
          <dd>
            <code className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground">
              {record.type}
            </code>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-foreground">Nombre (o &quot;host&quot;)</dt>
          <dd className="flex flex-col gap-1">
            <CopyableValue value={record.host} label="el nombre del registro" />
            <span className="text-xs text-muted-foreground">
              Escribe solo eso. Casi todos los proveedores le agregan tu dominio solos y el registro queda como{' '}
              <code className="font-mono">{record.name}</code>, que es lo correcto. Si tu proveedor te pide el nombre
              completo, entonces sí escribe <code className="break-all font-mono">{record.name}</code>.
            </span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-foreground">Valor</dt>
          <dd className="flex flex-col gap-1">
            <CopyableValue value={record.value} label="el valor del registro" />
            <span className="text-xs text-muted-foreground">
              Cópialo tal cual, sin comillas ni espacios. Este valor no cambia: si recargas la página o vuelves
              mañana, sigue siendo el mismo.
            </span>
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <h4 className="text-sm font-medium text-foreground">2. Apunta el dominio a tu tienda</h4>
        <p className="text-xs text-muted-foreground">
          El registro TXT solo nos sirve para comprobar que el dominio es tuyo; además tiene que apuntar a tu tienda.
          Si tu dominio empieza por una palabra (<code className="font-mono">www.{record.domain}</code> o{' '}
          <code className="font-mono">tienda.{record.domain}</code>), crea un registro CNAME hacia{' '}
          <code className="break-all font-mono">{primaryDomain ?? 'tu dirección de Ventia'}</code>. Si es el dominio
          a secas ({record.domain}), la mayoría de proveedores no permite un CNAME ahí: escríbenos y te damos la
          dirección IP para el registro A.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <h4 className="text-sm font-medium text-foreground">3. Vuelve y pulsa &quot;Verificar&quot;</h4>
        {verifyError ? (
          <Alert variant="error">{verifyError}</Alert>
        ) : help ? (
          <Alert variant="warning">
            <p>{help.headline}</p>
            {help.checks.length > 0 ? (
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                {help.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-2">{help.footnote}</p>
          </Alert>
        ) : (
          <p className="text-xs text-muted-foreground">
            Los cambios de DNS tardan desde unos minutos hasta varias horas. No tienes que quedarte esperando: puedes
            cerrar esta página y volver cuando quieras, tu tienda sigue funcionando en la dirección de arriba
            mientras tanto.
          </p>
        )}
      </div>
    </div>
  );
}

/** A value shown to be copied, with the raw text always visible and
 * selectable. Same component and same reasoning as the WhatsApp tab's: the
 * clipboard API is unavailable over plain http on a non-localhost origin, and
 * a copy button that silently does nothing is worse than none — so the failure
 * says so and the text stays selectable. */
function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground">
          {value}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={`Copiar ${label}`}
          onClick={() => void handleCopy()}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      {copyFailed ? (
        <span className="text-xs text-destructive">No pudimos copiarlo. Selecciónalo y cópialo manualmente.</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Adding one                                                                 */
/* -------------------------------------------------------------------------- */

function AddDomainForm({
  existing,
  platformRoot,
  onAdded,
  onPlanRefused,
}: {
  existing: TenantDomain[];
  platformRoot: string | null;
  onAdded: (added: { id: string; domain: string; token: string }) => void;
  onPlanRefused: () => void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const normalized = normalizeDomainInput(value);
  const typed = value.trim();
  // Only shown when it differs from what they typed, so it reads as "this is
  // what we understood" rather than as noise.
  const showsPreview = normalized !== null && normalized !== typed.toLowerCase();
  const alreadyAdded = normalized !== null && existing.some((item) => item.domain === normalized);
  const insideOurZone = normalized !== null && isPlatformDomain(normalized, platformRoot);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    if (normalized === null) {
      setFieldError(INVALID_DOMAIN_MESSAGE);
      return;
    }

    setSubmitting(true);
    try {
      const added = await addDomain(normalized);
      onAdded(added);
      setValue('');
    } catch (e) {
      if (e instanceof ApiError) {
        const field = addDomainFieldError(e);
        if (field) setFieldError(field);
        else if (e.code === 'PLAN_LIMIT_EXCEEDED') {
          // The list said the plan included custom domains and the write said
          // otherwise — a plan that changed under an open tab. Believe the
          // write: swapping the form for the upgrade prompt is the honest
          // response, and the merchant is not left retrying a form that can
          // only 402.
          onPlanRefused();
        } else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 border-t border-border pt-6" onSubmit={handleSubmit}>
      <h3 className="text-sm font-medium text-foreground">Conectar un dominio propio</h3>
      <p className="text-sm text-muted-foreground">
        Escribe el dominio que ya compraste. Después te mostramos un registro para publicar en tu proveedor de
        dominio; así comprobamos que es tuyo antes de dirigir tu tienda hacia allá.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField label="Dominio" htmlFor="nuevo-dominio" error={fieldError ?? undefined}>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="mitienda.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </FormField>
      {showsPreview ? (
        <p className="text-xs text-muted-foreground">
          Vamos a registrar <code className="font-mono">{normalized}</code>.
        </p>
      ) : null}
      {alreadyAdded ? (
        <p className="text-xs text-muted-foreground">Ese dominio ya está en tu lista de arriba.</p>
      ) : null}
      {insideOurZone ? (
        <p className="text-xs text-muted-foreground">
          Esa dirección es de Ventia, no un dominio propio. Si querías tu dirección de siempre, ya la tienes arriba.
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={submitting || alreadyAdded}>
          {submitting ? 'Agregando…' : 'Agregar dominio'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Si quieres que también funcione con <code className="font-mono">www</code> adelante, agrégalo aparte como{' '}
        <code className="font-mono">www.mitienda.com</code>: para el DNS son dos direcciones distintas.
      </p>
    </form>
  );
}
