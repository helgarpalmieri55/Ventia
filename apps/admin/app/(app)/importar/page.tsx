'use client';

import { useState, type ChangeEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Table, Tbody, Td, Th, Thead, Tr, cn } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { MAX_DISPLAYED_ERRORS, canCommit, dryRunToModel, type DryRunModel, type DryRunResponse, type RowError } from '../../../lib/csv-import';

// Mirrors services/api/src/csv-import/csv-import.service.ts's MAX_CSV_BYTES —
// checked client-side purely to avoid a wasted round-trip for an obviously
// oversized file/paste; the server re-checks independently (413
// CSV_TOO_LARGE) regardless of what the client computed.
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const SIZE_ERROR_MESSAGE = 'El archivo CSV supera el tamaño permitido.';

interface CommitResult {
  created: number;
  updated: number;
}

interface CsvInvalidDetails {
  errors: RowError[];
}

function isCsvInvalidDetails(value: unknown): value is CsvInvalidDetails {
  return typeof value === 'object' && value !== null && Array.isArray((value as { errors?: unknown }).errors);
}

const TEXTAREA_CLASS = cn(
  'flex w-full min-h-[240px] resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50',
);

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
    </div>
  );
}

/** Renders a row-errors table (fila/columna/mensaje), shared by the dry-run
 * preview and a rejected commit's `CSV_INVALID` response — both hand this
 * component the same `RowError[]` shape, just from different endpoints. */
function ErrorsTable({ errors, note }: { errors: RowError[]; note?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <Thead>
          <Tr>
            <Th>Fila</Th>
            <Th>Columna</Th>
            <Th>Mensaje</Th>
          </Tr>
        </Thead>
        <Tbody>
          {errors.map((error, index) => (
            <Tr key={`${error.row}-${error.column}-${index}`}>
              <Td>{error.row}</Td>
              <Td>{error.column}</Td>
              <Td>{error.message}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** Importar CSV page: template download, a file-or-text input for the CSV
 * content, a dry-run preview, and a commit step — the four-step flow called
 * out in the page's own instructions (spec M2's non-technical-user DoD).
 *
 * `lastDryRunCsv` (rather than a plain boolean) is what a dry-run actually
 * ran against, so editing the csv text after a dry-run makes `dirty` true
 * (comparing against the CURRENT `csvText`) without needing a separate
 * "mark dirty" call on every input handler — {@link canCommit} in
 * `lib/csv-import.ts` is the pure function this page defers that decision
 * to, and is unit-tested there independent of this component. */
export default function ImportarPage() {
  const [inputMode, setInputMode] = useState<'file' | 'text'>('file');
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const [dryRunModel, setDryRunModel] = useState<DryRunModel | null>(null);
  const [lastDryRunCsv, setLastDryRunCsv] = useState<string | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitErrors, setCommitErrors] = useState<RowError[] | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const dirty = csvText !== lastDryRunCsv;
  const commitEnabled = canCommit(dryRunModel, dirty);

  function applyCsvText(next: string) {
    setCsvText(next);
    setSizeError(byteLength(next) > MAX_CSV_BYTES ? SIZE_ERROR_MESSAGE : null);
    // Any edit stales a previous commit's result/errors — they described the
    // OLD text, not this one.
    setCommitResult(null);
    setCommitError(null);
    setCommitErrors(null);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    if (!selected) {
      setFileName(null);
      applyCsvText('');
      return;
    }
    // Check the file's own byte size before ever reading it — no point
    // loading a huge file into memory just to reject it a moment later.
    if (selected.size > MAX_CSV_BYTES) {
      setFileName(null);
      setSizeError(SIZE_ERROR_MESSAGE);
      applyCsvText('');
      return;
    }
    try {
      const text = await selected.text();
      setFileName(selected.name);
      applyCsvText(text);
    } catch {
      setFileName(null);
      setSizeError('No pudimos leer el archivo. Intenta de nuevo.');
    }
  }

  function handleTextareaChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setFileName(null);
    applyCsvText(event.target.value);
  }

  async function handleValidate() {
    if (!csvText.trim() || sizeError) return;
    setDryRunLoading(true);
    setDryRunError(null);
    setCommitResult(null);
    setCommitError(null);
    setCommitErrors(null);
    try {
      const response = await apiFetch<DryRunResponse>('/v1/admin/import/dry-run', {
        method: 'POST',
        body: JSON.stringify({ csv: csvText }),
      });
      setDryRunModel(dryRunToModel(response));
      setLastDryRunCsv(csvText);
    } catch (e) {
      setDryRunModel(null);
      setLastDryRunCsv(null);
      setDryRunError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setDryRunLoading(false);
    }
  }

  async function handleCommit() {
    if (!commitEnabled) return;
    setCommitLoading(true);
    setCommitError(null);
    setCommitErrors(null);
    setCommitResult(null);
    try {
      const response = await apiFetch<CommitResult>('/v1/admin/import/commit', {
        method: 'POST',
        body: JSON.stringify({ csv: csvText }),
      });
      setCommitResult(response);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CSV_INVALID' && isCsvInvalidDetails(e.details)) {
        setCommitErrors(e.details.errors);
      } else if (e instanceof ApiError) {
        setCommitError(errorMessage(e));
      } else {
        setCommitError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setCommitLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <CardTitle>Importar productos desde CSV</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <ol className="list-inside list-decimal text-sm text-foreground">
            <li>Descarga la plantilla.</li>
            <li>Llénala con tus productos (una fila por producto).</li>
            <li>Valida el archivo para revisar el resumen antes de importar.</li>
            <li>Importa cuando la validación no muestre errores.</li>
          </ol>
          <Button href="/api/v1/admin/import/template" variant="secondary" className="self-start">
            Descargar plantilla
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={inputMode === 'file' ? 'default' : 'secondary'}
              size="sm"
              onClick={() => setInputMode('file')}
            >
              Subir archivo
            </Button>
            <Button
              type="button"
              variant={inputMode === 'text' ? 'default' : 'secondary'}
              size="sm"
              onClick={() => setInputMode('text')}
            >
              Pegar texto
            </Button>
          </div>

          {inputMode === 'file' ? (
            <div className="flex flex-col gap-2">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void handleFileChange(event)}
                className="text-sm text-foreground"
              />
              {fileName ? <p className="text-sm text-muted-foreground">Archivo cargado: {fileName}</p> : null}
            </div>
          ) : (
            <textarea
              className={TEXTAREA_CLASS}
              value={csvText}
              onChange={handleTextareaChange}
              placeholder="Pega aquí el contenido del CSV"
            />
          )}

          {sizeError ? <Alert variant="error">{sizeError}</Alert> : null}

          <Button
            type="button"
            variant="secondary"
            className="self-start"
            disabled={!csvText.trim() || !!sizeError || dryRunLoading}
            onClick={() => void handleValidate()}
          >
            {dryRunLoading ? 'Validando…' : 'Validar archivo'}
          </Button>
          {dryRunError ? <Alert variant="error">{dryRunError}</Alert> : null}
        </div>

        {dryRunModel ? (
          <div className="flex flex-col gap-4 border-t border-border pt-6">
            {dirty ? (
              <Alert variant="info">El archivo cambió desde la última validación. Vuelve a validarlo antes de importar.</Alert>
            ) : null}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat label="Válidas" value={dryRunModel.valid} />
              <SummaryStat label="Con errores" value={dryRunModel.invalid} />
              <SummaryStat label="Nuevos" value={dryRunModel.creates} />
              <SummaryStat label="Actualizaciones" value={dryRunModel.updates} />
            </div>

            {dryRunModel.limitExceeded ? (
              <Alert variant="error">{errorMessage(new ApiError(402, 'PLAN_LIMIT_EXCEEDED'))}</Alert>
            ) : null}

            {dryRunModel.errors.length > 0 ? (
              <ErrorsTable
                errors={dryRunModel.errors}
                note={
                  dryRunModel.moreErrorRows > 0
                    ? `y ${dryRunModel.moreErrorRows} fila${dryRunModel.moreErrorRows === 1 ? '' : 's'} más con errores`
                    : undefined
                }
              />
            ) : null}

            <Button
              type="button"
              className="self-start"
              disabled={!commitEnabled || commitLoading}
              onClick={() => void handleCommit()}
            >
              {commitLoading ? 'Importando…' : 'Importar productos'}
            </Button>
          </div>
        ) : null}

        {commitError ? <Alert variant="error">{commitError}</Alert> : null}

        {commitErrors ? (
          <ErrorsTable
            errors={commitErrors}
            note={
              commitErrors.length >= MAX_DISPLAYED_ERRORS
                ? 'El archivo tiene más errores de los que se muestran aquí. Corrígelos y vuelve a validar.'
                : undefined
            }
          />
        ) : null}

        {commitResult ? (
          <Alert variant="success" className="flex flex-col gap-3">
            <span>
              Se crearon {commitResult.created} producto{commitResult.created === 1 ? '' : 's'} y se actualizaron{' '}
              {commitResult.updated}.
            </span>
            <Button href="/productos" variant="secondary" className="self-start">
              Ver productos
            </Button>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
