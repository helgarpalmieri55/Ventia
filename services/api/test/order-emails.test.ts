import { describe, expect, it, vi } from 'vitest';
import type { Mailer, MailMessage } from '../src/mailer/mailer';
import { sendOrderEmails, type OrderEmailContext } from '../src/mailer/order-emails';

/** A recording Mailer double: never touches a real Mailer implementation, so
 * this exercises only `sendOrderEmails`'s own logic. */
function recordingMailer(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: vi.fn(async (msg: MailMessage) => {
      sent.push(msg);
    }),
  };
  return { mailer, sent };
}

const BASE_CTX: OrderEmailContext = {
  orderNumber: 1042,
  email: 'shopper@example.com',
  phone: '3001234567',
  totalCents: 14165000,
  items: [
    { nameSnapshot: 'Camiseta', qty: 2, priceCentsSnapshot: 4590000 },
    { nameSnapshot: 'Gorra', qty: 1, priceCentsSnapshot: 2000000 },
  ],
  shippingAddress: { departamentoName: 'Bogotá, D.C.', municipioName: 'Bogotá, D.C.' },
  merchantContactEmail: null,
  tenantName: 'Tienda Demo',
};

describe('sendOrderEmails', () => {
  it('sends exactly 2 emails when merchantContactEmail is null (both to the shopper)', async () => {
    const { mailer, sent } = recordingMailer();

    await sendOrderEmails(mailer, { ...BASE_CTX, merchantContactEmail: null });

    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect(sent.every((m) => m.to === BASE_CTX.email)).toBe(true);
  });

  it('sends exactly 3 emails when merchantContactEmail is set (2 to the shopper, 1 to the merchant)', async () => {
    const { mailer, sent } = recordingMailer();

    await sendOrderEmails(mailer, { ...BASE_CTX, merchantContactEmail: 'dueño@tienda.co' });

    expect(mailer.send).toHaveBeenCalledTimes(3);
    expect(sent.filter((m) => m.to === BASE_CTX.email)).toHaveLength(2);
    expect(sent.filter((m) => m.to === 'dueño@tienda.co')).toHaveLength(1);
  });

  it('both shopper-facing emails carry the exact VNT-{orderNumber} subject substring and the correct total', async () => {
    const { sent } = await (async () => {
      const rec = recordingMailer();
      await sendOrderEmails(rec.mailer, BASE_CTX);
      return rec;
    })();

    const shopperEmails = sent.filter((m) => m.to === BASE_CTX.email);
    expect(shopperEmails).toHaveLength(2);
    for (const mail of shopperEmails) {
      expect(mail.subject).toContain('VNT-1042');
      expect(mail.text).toContain('$ 141.650');
    }

    expect(shopperEmails[0].subject).toBe('Confirmación de tu pedido #VNT-1042 — Tienda Demo');
    expect(shopperEmails[1].subject).toBe('Tu pedido contra entrega #VNT-1042');
  });

  it('the order-confirmation email lists every item with its name/qty/line total', async () => {
    const { mailer, sent } = recordingMailer();

    await sendOrderEmails(mailer, BASE_CTX);

    const confirmation = sent[0];
    expect(confirmation.text).toContain('Camiseta');
    expect(confirmation.text).toContain('x2');
    expect(confirmation.text).toContain('Gorra');
    expect(confirmation.text).toContain('x1');
  });

  it('the merchant alert email includes the shopper contact info (email/phone) and the VNT- order number', async () => {
    const { mailer, sent } = recordingMailer();

    await sendOrderEmails(mailer, { ...BASE_CTX, merchantContactEmail: 'dueño@tienda.co' });

    expect(mailer.send).toHaveBeenCalledTimes(3);
    const merchantMail = sent.find((m) => m.to === 'dueño@tienda.co');
    expect(merchantMail).toBeTruthy();
    expect(merchantMail!.subject).toBe('Nuevo pedido #VNT-1042');
    expect(merchantMail!.text).toContain(BASE_CTX.email);
    expect(merchantMail!.text).toContain(BASE_CTX.phone);
    expect(merchantMail!.text).toContain('$ 141.650');
  });
});
