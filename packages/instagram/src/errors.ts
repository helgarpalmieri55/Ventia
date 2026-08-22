/**
 * La lanza `sendText` cuando Meta rechaza el envío.
 *
 * Lleva el estado HTTP y el cuerpo porque los dos fallos que un operador de
 * verdad tiene que distinguir — "el token de página caducó" (401) y "estás
 * fuera de la ventana de 24 horas" (400 con `error.code` 10, subcódigo
 * 2534022) — son indistinguibles en una línea de log si solo se guarda el
 * mensaje.
 */
export class InstagramError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} sendText falló: HTTP ${status} ${body.slice(0, 200)}`);
    this.name = 'InstagramError';
  }
}
