/** The wrapper CSP of the production server (keep equal to server/src/http.ts WRAPPER_HEADERS). */
export const WRAPPER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'";
