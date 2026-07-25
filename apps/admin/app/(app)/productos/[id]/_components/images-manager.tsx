'use client';

import { useRef, useState } from 'react';
import { Alert, Button } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../../lib/api';
import { errorMessage } from '../../../../../lib/errors';
import type { ProductImage } from './product-types';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 8;

interface PresignResponse {
  uploadUrl: string;
  key: string;
  publicUrl: string;
}

export interface ImagesManagerProps {
  productId: string;
  images: ProductImage[];
  onImageAdded: (image: ProductImage) => void;
  onImageRemoved: (imageId: string) => void;
}

/** Section 3 of the edit page: current images grid (delete per image) plus
 * an upload flow of three requests:
 *
 * 1. `POST .../images/presign` (via `apiFetch`, JSON in/out) — returns an
 *    `uploadUrl` (a presigned, absolute S3/MinIO URL, not a same-origin
 *    `/api/...` path).
 * 2. `PUT` the file's raw bytes to that `uploadUrl` — this one call
 *    deliberately uses the plain `fetch` API instead of `apiFetch`:
 *    `apiFetch` unconditionally prefixes `/api` (wrong for an absolute
 *    external URL) and unconditionally sets `Content-Type:
 *    application/json` (wrong for a binary file body, and would in fact
 *    mismatch the `ContentType` the URL was signed for, at least for
 *    signers that bind it — see `lib/api.ts`'s header-merge order for why
 *    an override isn't clean here either).
 * 3. `POST .../images` (via `apiFetch` again) with the resulting `key` to
 *    confirm the upload and create the `ProductImage` row.
 *
 * Client-side type/size validation happens before any of that (jpeg/png/webp,
 * <= 5MB, mirroring `presignRequestSchema`) purely to avoid a wasted
 * round-trip — the server re-validates both independently of what the
 * client claims (`ImagesController.confirm`'s `HeadObject` check). */
export function ImagesManager({ productId, images, onImageAdded, onImageRemoved }: ImagesManagerProps) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const atLimit = images.length >= MAX_IMAGES;

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setUploadError(null);
    if (!selected) {
      setFile(null);
      setFileError(null);
      return;
    }
    if (!ALLOWED_TYPES.has(selected.type)) {
      setFile(null);
      setFileError('El archivo debe ser JPG, PNG o WEBP.');
      return;
    }
    if (selected.size > MAX_BYTES) {
      setFile(null);
      setFileError('El archivo no puede superar 5 MB.');
      return;
    }
    setFileError(null);
    setFile(selected);
  }

  async function handleUpload() {
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const presign = await apiFetch<PresignResponse>(`/v1/admin/products/${productId}/images/presign`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });

      const putResponse = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) {
        setUploadError('El archivo subido no es válido.');
        return;
      }

      const image = await apiFetch<ProductImage>(`/v1/admin/products/${productId}/images`, {
        method: 'POST',
        body: JSON.stringify({ key: presign.key, position: images.length }),
      });
      onImageAdded(image);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      setUploadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(imageId: string) {
    setDeleteError(null);
    setDeletingId(imageId);
    try {
      await apiFetch<void>(`/v1/admin/products/${productId}/images/${imageId}`, { method: 'DELETE' });
      onImageRemoved(imageId);
    } catch (e) {
      setDeleteError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">Este producto no tiene imágenes todavía.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {images.map((image) => (
            <div key={image.id} className="flex flex-col gap-2">
              <img src={image.url} alt={image.alt ?? ''} className="h-24 w-full rounded-md object-cover" />
              <Button
                variant="destructive"
                size="sm"
                disabled={deletingId === image.id}
                onClick={() => void handleDelete(image.id)}
              >
                {deletingId === image.id ? 'Eliminando…' : 'Eliminar'}
              </Button>
            </div>
          ))}
        </div>
      )}
      {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}

      <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          JPG, PNG o WEBP, máximo 5 MB. {images.length}/{MAX_IMAGES} imágenes.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          disabled={atLimit}
          className="text-sm text-foreground"
        />
        {fileError ? <Alert variant="error">{fileError}</Alert> : null}
        {uploadError ? <Alert variant="error">{uploadError}</Alert> : null}
        {atLimit ? <Alert variant="info">Alcanzaste el límite de imágenes permitido.</Alert> : null}
        <Button
          variant="secondary"
          className="self-start"
          disabled={!file || !!fileError || uploading || atLimit}
          onClick={() => void handleUpload()}
        >
          {uploading ? 'Subiendo…' : 'Subir imagen'}
        </Button>
      </div>
    </div>
  );
}
