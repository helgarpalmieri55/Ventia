import { PII_KEYS } from '../privacy/redact';

/**
 * The last thing that runs before a telemetry event leaves this process.
 *
 * ## Why this exists as its own module
 *
 * Sentry's job is to ship us everything it can find about a crash. In a
 * Colombian e-commerce API, "everything it can find" is a shopper's name,
 * their cédula, their phone, the street they live on and the session cookie
 * that authenticates their merchant — all of it Ley 1581 personal data whose
 * export to a third-party processor nobody consented to. The SDK's own
 * `sendDefaultPii: false` is necessary and nowhere near sufficient: it
 * suppresses a handful of well-known fields (IP, cookies) and does nothing
 * about `extra`, breadcrumbs, or an exception message that interpolated a
 * customer's address into its text.
 *
 * So this module treats the whole event as hostile until proven otherwise,
 * and is wired as `beforeSend`/`beforeSendTransaction`/`beforeBreadcrumb`
 * (see sentry.ts) — the last hook the SDK runs before serializing an
 * envelope. Verified rather than assumed: `@sentry/core`'s `client.js` calls
 * `processBeforeSend` after `prepareEvent` has already applied every
 * integration (so `requestDataIntegration`'s headers/body are visible to us),
 * and `envelope.js` `createEventEnvelope` is the next step.
 *
 * ## The two rules, borrowed from privacy/redact.ts
 *
 * `privacy/redact.ts` is this codebase's existing answer to "scrub personal
 * data out of loosely-typed JSON", written for the Ley 1581 anonymization
 * flow. Its structure is reused here rather than reinvented:
 *
 *  1. **By key.** {@link PII_KEYS} is IMPORTED from that module, not copied —
 *     one list of "keys whose value is personal data", maintained once. A key
 *     added there for the anonymizer is automatically respected here.
 *  2. **By value.** That module can match on a specific customer's known
 *     values, because it runs while holding that customer's row. Telemetry
 *     has no such anchor: nobody knows whose data is in the event. So the
 *     value rule here is by SHAPE — emails, Colombian mobile numbers,
 *     cédula/NIT-length digit runs, JWTs, bearer tokens, session cookies,
 *     AES-GCM ciphertext in this repo's own `iv:tag:ct` format.
 *
 * And its third idea, from `anonymizeAddress`: **where the schema is known,
 * decide field by field and drop what is not recognised.** A Sentry event
 * envelope is a known schema, so `request`, `user`, `exception` and
 * `breadcrumbs` get explicit per-field policies below (allowlisted headers,
 * no body ever, no stack-frame locals ever) instead of being run through the
 * heuristic walker and hoped for.
 *
 * ## What this does NOT catch, stated plainly
 *
 * A shopper's NAME interpolated into free prose — `Error: no se pudo crear el
 * pedido de Ana María Gómez` — survives, because a name is not a shape. There
 * is no regex for "is a person". The mitigations are structural, not
 * detective: request bodies are dropped whole (so the common path by which a
 * name reaches an event is closed), and any name under any of the ~40 keys in
 * `PII_KEYS` is blanked. `redact.ts` makes the same admission about itself
 * ("defense in depth, not a proof"), and the same conclusion follows: do not
 * put customer data in exception messages.
 */

/** Marker left behind by a KEY-based removal. Deliberately not
 * `ANON_REDACTED` (`[dato eliminado]`, the Ley 1581 database sentinel) — an
 * operator reading an event must be able to tell "the telemetry scrubber
 * removed this on the way out" from "this database row is anonymized". */
export const REDACTED = '[redacted]';
/** Markers left behind by VALUE-based (shape) rules. Typed, so an event says
 * what class of thing used to be there, which is most of the debugging value
 * a raw value would have carried. */
export const REDACTED_EMAIL = '[redacted:email]';
export const REDACTED_PHONE = '[redacted:phone]';
export const REDACTED_ID = '[redacted:id-number]';
export const REDACTED_TOKEN = '[redacted:token]';
export const REDACTED_SECRET = '[redacted:secret]';

/** Normalizes a key for matching — lowercased, `_`/`-`/space stripped, so
 * `customer_email`, `customerEmail` and `Customer-Email` collapse together.
 * One line duplicated from `privacy/redact.ts`, which keeps it private; the
 * list it is applied to (`PII_KEYS`) is imported rather than copied, which is
 * the part that would actually rot if it were duplicated. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Keys whose value is removed WHOLE — object, array or scalar alike — rather
 * than walked.
 *
 * Distinct from `PII_KEYS` because the failure mode is different. A value
 * under `shippingAddress` is structured data whose departamento is worth
 * keeping, so `PII_KEYS` walks into it. A value under `payload` is an entire
 * gateway webhook body, and a value under `credentials` is an encrypted
 * provider secret: there is nothing inside either that is worth the risk of
 * walking, and "walk it and trust the leaf rules" is exactly how a
 * `payer.legal_id` two levels down in a Wompi payload gets shipped to a third
 * party. Anything named like a secret or like a raw body is dropped entire.
 */
export const DROP_KEYS: ReadonlySet<string> = new Set([
  // Session / credential material.
  'cookie',
  'cookies',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'session',
  'sessionid',
  'sid',
  'jwt',
  'bearer',
  'apikey',
  'apitoken',
  'xapikey',
  'password',
  'passwd',
  'pass',
  'secret',
  'clientsecret',
  'integritysecret',
  'privatekey',
  'publickey',
  'authsecret',
  'signature',
  'checksum',
  'credential',
  'credentials',
  'encrypted',
  'encryptedvalue',
  'ciphertext',
  'authtag',
  // Connection strings — a DSN or DATABASE_URL carries a password inline.
  'dsn',
  'databaseurl',
  'redisurl',
  'connectionstring',
  // Raw bodies. `WebhookEvent.payload` is the named example; `redact.ts`
  // scrubs that same column in the database, and this is the same data on its
  // way out through a different door.
  'payload',
  'rawpayload',
  'webhookpayload',
  'body',
  'rawbody',
  'requestbody',
  'toolcalls',
  // Card data. Never stored by this platform (the gateway holds it), which is
  // precisely why it must never appear in telemetry either.
  'card',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
]);

/**
 * Request headers that survive. An allowlist, not a denylist: a denylist has
 * to have anticipated `x-tenant-domain`, `x-forwarded-for`, and whatever a
 * future integration starts sending, and gets it wrong silently.
 *
 * `referer` is deliberately absent — it carries the previous URL including
 * its query string, which is where a password-reset token lives.
 */
export const KEPT_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'user-agent',
  'x-request-id',
]);

// --- value (shape) rules ---------------------------------------------------
//
// Order matters and is not alphabetical: the rules that recognise a whole
// composite thing (a cookie pair, a JWT, this repo's ciphertext format) run
// BEFORE the rules that recognise a fragment (a digit run, a base64 blob), so
// that a token is replaced once by `[redacted:token]` rather than being
// half-eaten by two narrower rules.

/** This repo's own AES-256-GCM envelope from `payments/encryption.ts`:
 * `base64(12-byte iv):base64(16-byte tag):base64(ciphertext)`. Matched
 * exactly because we know its shape — the encrypted Wompi/WhatsApp
 * credentials in `Tenant.settings` are the highest-value string in the
 * process. */
const CIPHERTEXT_RE =
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{15,}={0,2}:[A-Za-z0-9+/]{15,}={0,2}:[A-Za-z0-9+/]{8,}={0,2}/g;
/** `header.payload.signature`, base64url. Session tokens, better-auth
 * verification links, provider access tokens. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
/** `Authorization: Bearer …` / `Basic …`, wherever the whole header line got
 * stringified into a message. */
const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** A `name=value` pair whose NAME looks like a session. Replaces only the
 * value, so the event still says which cookie was present — that is genuinely
 * useful when debugging an auth bug and carries nothing personal. */
const COOKIE_PAIR_RE = /(?<![\w-])([A-Za-z0-9_.-]*(?:session|sess|token|auth|sid|csrf|jwt)[A-Za-z0-9_.-]*)=([^;,\s"']+)/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Colombian mobile: ten digits starting with 3, optionally `+57`-prefixed
 * and optionally separated — the format `packages/whatsapp`'s
 * `normalizePhone` accepts and the format shoppers type at checkout. */
const CO_PHONE_RE = /(?<![\d+])(?:\+?57[\s.-]?)?\(?3\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
/** Any other international number in `+CC …` form. */
const INTL_PHONE_RE = /\+\d{1,3}[\s.-]?\d[\d\s.-]{6,14}\d/g;
/** A cédula written with Colombian thousand separators: `1.020.345.678`. */
const DOTTED_ID_RE = /(?<![\w.-])\d{1,3}(?:\.\d{3}){2,4}(?![\w.-])/g;
/** A bare run of 7–20 digits: cédula (7–10), NIT (9–10), card (13–19).
 *
 * Knowingly over-broad — it also eats a 13-digit epoch-millis timestamp and a
 * long order total in centavos. That trade is made on purpose and in one
 * direction only: an over-redacted timestamp costs a debugging session, an
 * under-redacted cédula is a reportable Habeas Data incident. `redact.ts`
 * reasons the opposite way (`MIN_SUBSTRING_SECRET`) for the opposite
 * situation — it edits an audit trail in place, where over-redaction is also
 * unrecoverable. Nothing here is a system of record. */
const DIGIT_RUN_RE = /(?<![\w.-])\d{7,20}(?![\w.-])/g;
/** A long hex blob: hashes, HMAC signatures, raw keys. */
const HEX_BLOB_RE = /(?<![\w-])[0-9a-f]{32,}(?![\w-])/gi;
/** A long base64 blob. The three lookaheads (must contain a digit, an
 * uppercase and a lowercase) exist to spare stack traces: `/home/user/Ventia/
 * services/api/src/observability` is 40+ characters drawn from the same
 * alphabet, and shredding file paths would make crash reports useless. Real
 * base64 of random bytes satisfies all three with overwhelming probability;
 * a directory path essentially never carries a digit AND mixed case with no
 * separator. */
const B64_BLOB_RE =
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g;

/**
 * Applies every value rule to one string. Exported because it is reused
 * outside Sentry: BullMQ's `failedReason` is an error message written by a
 * worker and read by an operator over HTTP, and it deserves the same
 * treatment (see queue-health.service.ts).
 */
export function scrubString(value: string): string {
  if (value.length === 0) return value;
  return value
    .replace(CIPHERTEXT_RE, REDACTED_SECRET)
    .replace(JWT_RE, REDACTED_TOKEN)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED_TOKEN}`)
    .replace(COOKIE_PAIR_RE, (_m, name: string) => `${name}=${REDACTED_TOKEN}`)
    .replace(EMAIL_RE, REDACTED_EMAIL)
    .replace(CO_PHONE_RE, REDACTED_PHONE)
    .replace(INTL_PHONE_RE, REDACTED_PHONE)
    .replace(DOTTED_ID_RE, REDACTED_ID)
    .replace(DIGIT_RUN_RE, REDACTED_ID)
    .replace(HEX_BLOB_RE, REDACTED_SECRET)
    .replace(B64_BLOB_RE, REDACTED_SECRET);
}

/** Deepest structure the walker will follow. Beyond this everything is
 * dropped rather than passed through unscrubbed — the only safe direction for
 * a bound whose purpose is to stop a cyclic or pathological object from
 * hanging the process. */
const MAX_DEPTH = 8;
/** Most array elements walked; the rest are dropped, with a marker so the
 * truncation is visible rather than silent. */
const MAX_ARRAY = 50;

/**
 * The free-form walker — `extra`, `contexts`, `tags`, breadcrumb `data`, and
 * anything else whose schema is "whatever a developer passed".
 *
 * Same shape as `redact.ts`'s `walk`: key rules decide, value rules clean up
 * what the key rules let through.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  // Sentry normalizes an event before `beforeSend` runs, so by then a Date is
  // already a string — but this walker is exported and reused, and walking a
  // Date's (empty) own-property list would silently turn it into `{}`.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((item) => scrubValue(item, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[${value.length - MAX_ARRAY} more items dropped]`);
    return out;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const norm = normalizeKey(key);
      if (DROP_KEYS.has(norm)) {
        out[key] = REDACTED;
      } else if (PII_KEYS.has(norm)) {
        // Same rule as redact.ts: a scalar under a PII key is blanked, a
        // structure under one is walked so its non-personal parts (a
        // departamento, a country code) survive.
        const inner = source[key];
        out[key] = inner !== null && typeof inner === 'object' ? scrubValue(inner, depth + 1) : REDACTED;
      } else {
        out[key] = scrubValue(source[key], depth + 1);
      }
    }
    return out;
  }
  // Functions, symbols, bigints: not something we can reason about, so not
  // something we send.
  return REDACTED;
}

// --- the event envelope ----------------------------------------------------

/** The parts of a Sentry event this module touches. Declared structurally
 * rather than imported from `@sentry/node`, so the scrubber — and every test
 * of it — stays runnable with the SDK absent or never loaded. */
export interface TelemetryEvent {
  message?: unknown;
  logentry?: { message?: unknown; params?: unknown } | undefined;
  request?: Record<string, unknown> | undefined;
  user?: Record<string, unknown> | undefined;
  extra?: Record<string, unknown> | undefined;
  contexts?: Record<string, unknown> | undefined;
  tags?: Record<string, unknown> | undefined;
  breadcrumbs?: TelemetryBreadcrumb[] | undefined;
  exception?: { values?: TelemetryExceptionValue[] } | undefined;
  [key: string]: unknown;
}

export interface TelemetryBreadcrumb {
  message?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

interface TelemetryExceptionValue {
  type?: unknown;
  value?: unknown;
  stacktrace?: { frames?: Array<Record<string, unknown>> } | undefined;
  [key: string]: unknown;
}

/** Strips the query string off a URL, keeping the path. Query strings carry
 * `?email=`, `?token=`, `?documento=` — and the path is what identifies the
 * route, which is the part worth having. */
function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const scrubbed = scrubString(path);
  return cut === -1 ? scrubbed : `${scrubbed}?${REDACTED}`;
}

/**
 * `event.request` — a known schema, so an explicit decision per field.
 *
 * - `data` (the parsed body) is **always** dropped. Not scrubbed: dropped.
 *   Every checkout body is a name, a phone, a cédula and a street address; a
 *   Wompi webhook body is the same data in a shape nobody here designed.
 *   There is no version of "send the body, carefully" that is worth it.
 * - `cookies` dropped, `env` dropped (it carries `REMOTE_ADDR`).
 * - `headers` allowlisted (see {@link KEPT_HEADERS}).
 * - `query_string` dropped, `url` truncated at the `?`.
 */
function scrubRequest(request: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof request.method === 'string') out.method = request.method;
  if (typeof request.url === 'string') out.url = stripQuery(request.url);
  const headers = request.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (KEPT_HEADERS.has(name.toLowerCase())) kept[name] = scrubValue(value);
    }
    out.headers = kept;
  }
  return out;
}

/**
 * `event.user` — keep the opaque internal id, drop everything that names a
 * human. `id` is a better-auth user id: it identifies a MERCHANT operator,
 * not a shopper, it is meaningless outside our own database, and without it
 * an error report cannot be tied to the person who reported it.
 */
function scrubUser(user: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof user.id === 'string') out.id = user.id;
  // Set explicitly rather than merely omitted: Sentry's server fills in the
  // caller's IP when `ip_address` is the string `{{auto}}` or absent under
  // some configurations, and `null` is the documented way to say "never".
  out.ip_address = null;
  return out;
}

/**
 * Exception values and their stack frames.
 *
 * `value` (the message) gets the value rules — this is where an interpolated
 * phone number or cédula shows up. `type`, `filename`, `function` and the
 * source-context lines are left ALONE: they are code, not data, and running
 * `DIGIT_RUN_RE` over them would corrupt line numbers and minified frame
 * names for no privacy gain.
 *
 * `frames[].vars` is deleted unconditionally. Sentry does not capture local
 * variables by default, but `localVariablesIntegration` exists, is one line
 * away from being enabled by someone chasing a hard bug, and would attach the
 * entire request body of the failing handler as a local. This is the cheapest
 * insurance in the file.
 */
function scrubException(exception: { values?: TelemetryExceptionValue[] }): { values?: TelemetryExceptionValue[] } {
  if (!Array.isArray(exception.values)) return exception;
  for (const value of exception.values) {
    if (typeof value.value === 'string') value.value = scrubString(value.value);
    const frames = value.stacktrace?.frames;
    if (Array.isArray(frames)) {
      for (const frame of frames) delete frame.vars;
    }
  }
  return exception;
}

/**
 * Scrubs one breadcrumb. Breadcrumbs are the quiet leak: every
 * `console.log`/`console.error` in this codebase becomes one, and this
 * codebase logs order ids, error messages and — in the workers — whatever the
 * failure carried with it. Exported so it can be wired as `beforeBreadcrumb`
 * too, which catches them one at a time as they are recorded rather than only
 * at send time.
 */
export function scrubBreadcrumb(breadcrumb: TelemetryBreadcrumb): TelemetryBreadcrumb {
  if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubString(breadcrumb.message);
  if (breadcrumb.data !== undefined) {
    const data = breadcrumb.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const walked = scrubValue(data) as Record<string, unknown>;
      // http breadcrumbs put the full outbound URL here, query string and all.
      if (typeof walked.url === 'string') walked.url = stripQuery(walked.url);
      breadcrumb.data = walked;
    } else {
      breadcrumb.data = scrubValue(data);
    }
  }
  return breadcrumb;
}

/**
 * Scrubs a whole event, in place, and returns it (Sentry's `beforeSend`
 * contract). Never throws: see {@link scrubEventOrDrop}, which is what is
 * actually wired up.
 */
export function scrubEvent(event: TelemetryEvent): TelemetryEvent {
  if (typeof event.message === 'string') event.message = scrubString(event.message);
  if (event.logentry && typeof event.logentry === 'object') {
    if (typeof event.logentry.message === 'string') event.logentry.message = scrubString(event.logentry.message);
    if (event.logentry.params !== undefined) event.logentry.params = scrubValue(event.logentry.params);
  }
  if (event.request && typeof event.request === 'object') event.request = scrubRequest(event.request);
  if (event.user && typeof event.user === 'object') event.user = scrubUser(event.user);
  if (event.exception && typeof event.exception === 'object') event.exception = scrubException(event.exception);
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.extra && typeof event.extra === 'object') event.extra = scrubValue(event.extra) as Record<string, unknown>;
  if (event.contexts && typeof event.contexts === 'object') {
    event.contexts = scrubValue(event.contexts) as Record<string, unknown>;
  }
  if (event.tags && typeof event.tags === 'object') event.tags = scrubValue(event.tags) as Record<string, unknown>;
  return event;
}

/**
 * What `beforeSend` actually calls.
 *
 * **Fails closed.** If scrubbing throws — a getter that explodes, a proxy, a
 * cyclic structure the depth bound did not save us from — the event is
 * DROPPED (`null`), not sent unscrubbed. An error report we never see is a
 * bad day; a shopper's cédula sitting in a third-party SaaS because our
 * scrubber hit an edge case is a Habeas Data violation, and the asymmetry is
 * not close.
 */
export function scrubEventOrDrop(event: TelemetryEvent): TelemetryEvent | null {
  try {
    return scrubEvent(event);
  } catch (err) {
    console.error(
      '[observability] scrubbing an event threw; dropping it rather than sending it unscrubbed',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
