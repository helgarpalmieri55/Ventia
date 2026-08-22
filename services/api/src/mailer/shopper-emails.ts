import type { Mailer } from './mailer';

/**
 * The four emails a shopper account sends.
 *
 * All of them carry a link and nothing else of value, which is why they are
 * grouped: the security property that matters is the same in every case — the
 * link is the only place where "this address has an account here" is ever
 * stated. `ShopperAuthService` answers every request identically whether or
 * not the account exists precisely so that this email is the only channel
 * carrying that fact, and only its owner can read it.
 */

export type ShopperEmailKind = 'verify_email' | 'magic_link' | 'password_reset' | 'already_registered';

export interface ShopperLinkEmail {
  kind: ShopperEmailKind;
  to: string;
  url: string;
}

/** Spanish, informal-but-not-chummy, matching the order emails and the
 * generated legal documents. A shopper who gets one of these is mid-task; the
 * subject line has to say which task. */
const COPY: Record<ShopperEmailKind, { subject: string; body: (url: string) => string }> = {
  verify_email: {
    subject: 'Confirma tu correo',
    body: (url) =>
      [
        'Hola,',
        '',
        'Confirma tu correo para terminar de crear tu cuenta:',
        url,
        '',
        'El enlace vence en 24 horas.',
        '',
        'Si no creaste ninguna cuenta, puedes ignorar este mensaje.',
      ].join('\n'),
  },
  magic_link: {
    subject: 'Tu enlace para entrar',
    body: (url) =>
      [
        'Hola,',
        '',
        'Entra a tu cuenta con este enlace:',
        url,
        '',
        'Vence en 15 minutos y solo se puede usar una vez.',
        '',
        'Si no lo pediste, ignora este mensaje: nadie entró a tu cuenta.',
      ].join('\n'),
  },
  password_reset: {
    subject: 'Cambia tu contraseña',
    body: (url) =>
      [
        'Hola,',
        '',
        'Puedes elegir una contraseña nueva acá:',
        url,
        '',
        'Vence en 15 minutos y solo se puede usar una vez. Al cambiarla vamos a',
        'cerrar la sesión en todos los dispositivos donde hayas entrado.',
        '',
        'Si no lo pediste, ignora este mensaje: tu contraseña actual sigue igual.',
      ].join('\n'),
  },
  // Sent to the OWNER of an address someone else just tried to register with.
  // It must not read as an accusation — the overwhelmingly common cause is the
  // owner themselves forgetting they already have an account — while still
  // being clear that nothing was created or changed.
  already_registered: {
    subject: 'Ya tienes una cuenta con este correo',
    body: (url) =>
      [
        'Hola,',
        '',
        'Alguien intentó crear una cuenta con este correo, pero ya tenías una.',
        'No creamos nada nuevo y tu contraseña no cambió.',
        '',
        'Si fuiste tú, entra directo con este enlace:',
        url,
        '',
        'Vence en 15 minutos. Si no reconoces el intento, no tienes que hacer nada.',
      ].join('\n'),
  },
};

/**
 * Sends one of them. Awaited by the caller rather than fired and forgotten:
 * unlike the order emails — where the order exists whether or not the mail
 * lands — these emails ARE the flow. A shopper told "revisa tu correo" who
 * never receives anything has no path forward and no way to know why.
 */
export async function sendShopperLinkEmail(mailer: Mailer, email: ShopperLinkEmail): Promise<void> {
  const copy = COPY[email.kind];
  await mailer.send({ to: email.to, subject: copy.subject, text: copy.body(email.url) });
}
