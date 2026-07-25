'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Spinner } from '@ventia/ui';
import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { checklistItems, missingItems, type Checklist } from '../../lib/checklist';

/** `_components`: a Next.js "private folder" — never treated as a route
 * segment — living at the `app/` root (rather than under a single route
 * group) because both the onboarding wizard's last step
 * (`(setup)/onboarding`) and the standalone launch page (`(app)/lanzamiento`)
 * render the exact same checklist + launch UI (task-3 brief: "same checklist
 * component reused"). */

interface OnboardingGetResponse {
  steps: Record<string, unknown>;
  checklist: Checklist;
}

interface SettingsResponse {
  slug: string;
  status: string;
}

interface LaunchResponse {
  status: 'live';
  checklist?: Checklist;
}

const ROOT_DOMAIN = 'ventia.localhost';

export interface ChecklistPanelProps {
  /** Called once `POST /v1/admin/launch` succeeds — lets an embedding wizard
   * know it can move on to its own "done" state. Optional: the standalone
   * /lanzamiento page has nothing extra to do beyond this panel's own
   * success view. */
  onLaunched?: () => void;
}

/** The launch checklist screen: fetches the checklist + tenant slug/status,
 * shows the 4 items with status icons, a refresh button, and the "Lanzar
 * tienda" action. A 422 `LAUNCH_CHECKLIST_INCOMPLETE` response re-renders the
 * checklist from the error's own `details` (no extra round-trip) and lists
 * which items are still missing; success shows the storefront link and a
 * button back to the dashboard. */
export function ChecklistPanel({ onLaunched }: ChecklistPanelProps) {
  const router = useRouter();
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [onboarding, settings] = await Promise.all([
        apiFetch<OnboardingGetResponse>('/v1/admin/onboarding'),
        apiFetch<SettingsResponse>('/v1/admin/settings'),
      ]);
      setChecklist(onboarding.checklist);
      setSlug(settings.slug);
      setStatus(settings.status);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleLaunch() {
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await apiFetch<LaunchResponse>('/v1/admin/launch', { method: 'POST' });
      setStatus(result.status);
      if (result.checklist) setChecklist(result.checklist);
      onLaunched?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'LAUNCH_CHECKLIST_INCOMPLETE') {
        setChecklist(e.details as Checklist);
        setLaunchError(errorMessage(e));
      } else if (e instanceof ApiError) {
        setLaunchError(errorMessage(e));
      } else {
        setLaunchError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setLaunching(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando lista de lanzamiento…
      </div>
    );
  }

  if (loadError || !checklist) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="error">{loadError ?? 'No pudimos cargar la lista de lanzamiento.'}</Alert>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const items = checklistItems(checklist);
  const isLive = status === 'live';
  const storeUrl = slug ? `http://${slug}.${ROOT_DOMAIN}` : null;

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <span className="text-sm text-foreground">{item.label}</span>
            <Badge variant={item.done ? 'default' : 'secondary'}>{item.done ? 'Listo' : 'Pendiente'}</Badge>
          </li>
        ))}
      </ul>

      <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()} disabled={loading}>
        Actualizar
      </Button>

      {isLive ? (
        <Alert variant="success" className="flex flex-col gap-3">
          <p className="font-medium">Tu tienda ya está en línea.</p>
          {storeUrl ? (
            <a href={storeUrl} target="_blank" rel="noreferrer" className="text-primary underline">
              {storeUrl}
            </a>
          ) : null}
          <Button
            className="self-start"
            onClick={() => {
              router.push('/');
              router.refresh();
            }}
          >
            Ir al panel
          </Button>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          {launchError ? (
            <Alert variant="error" className="flex flex-col gap-2">
              <p>{launchError}</p>
              {missingItems(checklist).length > 0 ? (
                <ul className="list-inside list-disc text-sm">
                  {missingItems(checklist).map((item) => (
                    <li key={item.key}>{item.label}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}
          <Button onClick={() => void handleLaunch()} disabled={launching} className="self-start">
            {launching ? 'Lanzando…' : 'Lanzar tienda'}
          </Button>
        </div>
      )}
    </div>
  );
}
