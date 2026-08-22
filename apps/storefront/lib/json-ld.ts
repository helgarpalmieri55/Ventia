/**
 * Serializing a value for a `<script type="application/ld+json">` tag.
 *
 * ## Why `JSON.stringify` alone is not enough
 *
 * The JSON grammar has no opinion about `<`, and `JSON.stringify` therefore
 * emits it literally. Inside a `<script>` element that matters, because the
 * HTML parser is not reading JSON — it is scanning for the byte sequence that
 * ends the element. A product description containing
 *
 *     </script><img src=x onerror=...>
 *
 * closes the tag early and everything after it is parsed as markup. The JSON
 * is still perfectly valid; it simply never reaches a JSON parser.
 *
 * That is not a hypothetical input here. Every string in the PDP's structured
 * data — the product name, the description — is text a merchant typed into the
 * admin product form or, more to the point, text that arrived in a CSV they
 * imported from a supplier and never read line by line. Neither is "our own
 * data" in the sense that matters; both are untrusted text being placed into
 * an HTML context.
 *
 * The consequence is stored XSS on the storefront. The session cookies are
 * `HttpOnly`, so the script cannot read them — but it does not need to. It
 * runs on the storefront's own origin, which is exactly the origin whose
 * `/api/account/*` Route Handlers attach those cookies for it: the injected
 * script can read the shopper's saved addresses and order history, and act as
 * them, without ever seeing a cookie value.
 *
 * ## The escaping
 *
 * `<`, `>` and `&` become their `\uXXXX` forms. These are valid JSON string
 * escapes, so `JSON.parse` — and every JSON-LD consumer, Google's included —
 * reads back a byte-identical string; only the HTML parser sees a difference,
 * and what it sees is a sequence that cannot terminate the element.
 *
 * U+2028 and U+2029 are escaped for a different reason: they are legal raw in
 * JSON but are line terminators in JavaScript, so a consumer that reaches this
 * payload through a `<script>` eval path rather than `JSON.parse` would hit a
 * syntax error on them.
 *
 * Replacing across the whole serialized string is safe rather than merely
 * convenient: none of these five characters is part of JSON's own structural
 * syntax (`{}[]:,"` plus number and keyword characters), so every occurrence
 * is necessarily inside a string literal.
 */
const HTML_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * JSON for a `<script type="application/ld+json">` body, safe to hand to
 * `dangerouslySetInnerHTML`.
 *
 * Use this and not bare `JSON.stringify` at every structured-data tag.
 *
 * The character class is written with `\u` escapes rather than the literal
 * code points on purpose. U+2028 IS a line terminator to a JavaScript parser,
 * so a literal one inside this regex ends the line mid-expression and the file
 * fails to compile — the same property that makes it worth escaping in the
 * output makes it unusable in the source.
 */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => HTML_ESCAPES[char] as string);
}
