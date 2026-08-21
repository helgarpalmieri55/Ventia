'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, FormField, Input, Select, Spinner } from '@ventia/ui';
import { ApiError } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';
import {
  CONTENT_LABELS,
  CONTENT_PATHS,
  CONTENT_TYPES,
  fetchContent,
  generatePrivacyPolicy,
  generateTerms,
  saveContent,
  type ContentItem,
  type ContentType,
  type GeneratedPolicy,
} from '../lib/content-api';

/**
 * The content types this app can draft for the merchant, and the copy that
 * explains why they would want it.
 *
 * A table rather than two `type === '...'` branches: the two generators are
 * identical in every way that touches this component — a POST that writes
 * nothing, a `{ title, bodyMd, placeholders, disclaimer }` result, and the
 * same "ask before replacing what the merchant wrote" rule — and the only
 * thing that differs is which endpoint and which sentence. A second branch
 * would be a second copy of the confirm/replace flow to keep in sync, which
 * is exactly where a guard rail quietly stops guarding one of the two.
 */
const GENERATORS: Partial<Record<ContentType, { heading: string; blurb: string; run: () => Promise<GeneratedPolicy> }>> =
  {
    policy_terms: {
      heading: 'Términos y condiciones',
      blurb:
        'En Colombia, una tienda en línea debe tener publicadas las condiciones generales de sus ventas y ' +
        'debe informarle al cliente, antes de que compre, su derecho de retracto y el plazo para ejercerlo ' +
        '(Ley 1480 de 2011). Podemos redactarte un borrador con los datos de tu tienda: tu identificación, ' +
        'tus medios de pago, tus opciones de envío y tus zonas de contra entrega.',
      run: generateTerms,
    },
    policy_privacy: {
      heading: 'Política de tratamiento de datos personales',
      blurb:
        'En Colombia, toda tienda que recoja datos de sus clientes debe publicar su política de tratamiento ' +
        'de datos personales (Ley 1581 de 2012). Podemos redactarte un borrador con los datos de tu tienda ' +
        'para que lo revises y lo ajustes.',
      run: generatePrivacyPolicy,
    },
  };

/**
 * Contenido tab: the storefront's policy/content pages editor (docs/SPEC.md §6
 * M8, "policy pages editor"), including the Ley 1581 privacy-policy generator
 * required by §9 and the Ley 1480 términos y condiciones generator.
 *
 * The generator never publishes. It fills the editor, the merchant reads and
 * edits it, and a separate "Guardar" writes it — mirroring the API, where
 * generation is a pure read (`POST .../generate` writes nothing) and only
 * `PUT /v1/admin/content/:type` publishes. When the editor already holds text,
 * the button asks before replacing it: a merchant's own words are never
 * overwritten by a click they did not confirm.
 */
export function ContenidoTab() {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [type, setType] = useState<ContentType>('policy_privacy');
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [generated, setGenerated] = useState<GeneratedPolicy | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  /** Loads every content row and shows the one currently selected. */
  const load = useCallback(
    async (selected: ContentType) => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await fetchContent();
        setItems(result.items);
        const row = result.items.find((i) => i.type === selected);
        setTitle(row?.title ?? CONTENT_LABELS[selected]);
        setBodyMd(row?.bodyMd ?? '');
      } catch (e) {
        setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load('policy_privacy');
  }, [load]);

  function selectType(next: ContentType) {
    setType(next);
    setSaved(false);
    setError(null);
    setErrors({});
    setGenerated(null);
    setConfirmReplace(false);
    const row = items?.find((i) => i.type === next);
    setTitle(row?.title ?? CONTENT_LABELS[next]);
    setBodyMd(row?.bodyMd ?? '');
  }

  async function handleGenerate() {
    const generator = GENERATORS[type];
    if (!generator) return;
    // Guard rail, not a nag: only asks when there is something to lose.
    if (bodyMd.trim().length > 0 && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setGenerating(true);
    setError(null);
    setSaved(false);
    try {
      const result = await generator.run();
      setGenerated(result);
      setTitle(result.title);
      setBodyMd(result.bodyMd);
      setConfirmReplace(false);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await saveContent(type, title, bodyMd);
      setItems((prev) =>
        (prev ?? []).map((i) => (i.type === type ? { ...i, title: updated.title, bodyMd: updated.bodyMd } : i)),
      );
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(errorMessage(e));
        setErrors(fieldErrors(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando contenido…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="error">{loadError}</Alert>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void load(type)}>
          Reintentar
        </Button>
      </div>
    );
  }

  const storefrontPath = CONTENT_PATHS[type];
  const generator = GENERATORS[type];

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Publicamos esta página en tu tienda.</Alert> : null}

      <FormField label="Página" htmlFor="contentType">
        <Select id="contentType" value={type} onChange={(e) => selectType(e.target.value as ContentType)}>
          {CONTENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {CONTENT_LABELS[value]}
            </option>
          ))}
        </Select>
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        {storefrontPath
          ? `Se publica en ${storefrontPath} de tu tienda.`
          : 'No se publica como página: la usa tu asistente de IA para responder.'}
      </p>

      {generator ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <p className="text-sm font-medium text-foreground">{generator.heading}</p>
          <p className="text-xs text-muted-foreground">{generator.blurb}</p>
          {confirmReplace ? (
            <Alert variant="warning" className="flex flex-col gap-2">
              <p className="text-sm">
                Ya tienes un texto escrito. Si generas el borrador, lo reemplazamos por completo. ¿Seguimos?
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => void handleGenerate()} disabled={generating}>
                  Sí, reemplazar
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmReplace(false)}>
                  Cancelar
                </Button>
              </div>
            </Alert>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="self-start"
              onClick={() => void handleGenerate()}
              disabled={generating}
            >
              {generating ? 'Generando…' : 'Generar con los datos de mi tienda'}
            </Button>
          )}

          {generated ? (
            <>
              {/* The one thing the merchant must understand and the shopper
                  must never be shown: this is a template, and the party who
                  answers for it — Responsable del Tratamiento under Ley 1581,
                  proveedor under Ley 1480 — is the merchant, not the platform.
                  It arrives in the API RESPONSE, never inside `bodyMd`, so
                  there is no path by which it reaches a published page. */}
              <Alert variant="warning">{generated.disclaimer}</Alert>
              {generated.placeholders.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-foreground">
                    Faltan estos datos — búscalos como [COMPLETAR: …] en el texto:
                  </p>
                  <ul className="list-inside list-disc text-sm text-muted-foreground">
                    {generated.placeholders.map((hint) => (
                      <li key={hint}>{hint}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <Alert variant="success">
                  Llenamos todos los datos con la información de tu tienda. Revísalo y publícalo.
                </Alert>
              )}
              {type === 'policy_terms' ? (
                <p className="text-xs text-muted-foreground">
                  Este borrador ya describe tus medios de pago, tus opciones de envío y tus zonas de contra
                  entrega tal como los tienes configurados hoy. Si los cambias, vuelve a generarlo o edita el
                  texto: lo que quede publicado es lo que te pueden exigir.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <FormField label="Título" htmlFor="contentTitle" error={errors.title}>
        <Input id="contentTitle" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
      </FormField>

      <FormField label="Contenido" htmlFor="contentBody" error={errors.bodyMd}>
        <textarea
          id="contentBody"
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          rows={18}
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Deja una línea en blanco entre párrafos. Así se ven separados en tu tienda.
      </p>

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar y publicar'}
      </Button>
    </form>
  );
}
