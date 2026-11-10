/**
 * The bundled hand font of the "draw" text style: Shantell Sans 400 (SIL OFL 1.1, see
 * public/fonts/OFL.txt), latin + latin-ext subsets as same-origin woff2 files under
 * `<base>/fonts/`, so the wrapper CSP (font-src falls back to 'self') allows them and the
 * look does not depend on the fonts installed on each machine (Linux fell back to serif).
 *
 * Export rasterises an SVG through an <img>, which cannot load any external resource, so the
 * export SVG embeds the same faces as base64 `@font-face` rules (exportFontCss).
 */
import { HAND_FAMILY, clearMeasureCache } from './text';

export { HAND_FAMILY };

export interface BundledFace {
  file: string;
  unicodeRange: string;
}

/** Same subsets and ranges as @fontsource/shantell-sans 5.3.0 (unicode.json). */
export const HAND_FACES: BundledFace[] = [
  {
    file: 'shantell-sans-latin-400-normal.woff2',
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
  {
    file: 'shantell-sans-latin-ext-400-normal.woff2',
    unicodeRange:
      'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  },
];

export function fontUrl(file: string, base: string = import.meta.env.BASE_URL): string {
  return `${base.endsWith('/') ? base : `${base}/`}fonts/${file}`;
}

/** `@font-face` rules for `faces`, each with its own `src` (a URL or a data: URL). */
export function fontFaceCss(faces: { src: string; unicodeRange: string }[], family = HAND_FAMILY): string {
  return faces
    .map((f) => `@font-face{font-family:"${family}";font-style:normal;font-weight:400;src:url("${f.src}") format("woff2");unicode-range:${f.unicodeRange};}`)
    .join('');
}

let loading: Promise<boolean> | null = null;

/**
 * Register and load the bundled faces in this document. `onLoaded` runs once they are ready
 * (text measured with the fallback font must be laid out again). Resolves false on failure;
 * the font stack then falls back to the system hand fonts.
 */
export function loadHandFont(onLoaded?: () => void): Promise<boolean> {
  if (loading) return loading;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return Promise.resolve(false);
  loading = Promise.all(
    HAND_FACES.map((f) => {
      const face = new FontFace(HAND_FAMILY, `url("${fontUrl(f.file)}") format("woff2")`, {
        style: 'normal',
        weight: '400',
        unicodeRange: f.unicodeRange,
        display: 'swap',
      });
      document.fonts.add(face);
      return face.load();
    }),
  ).then(
    () => {
      clearMeasureCache();
      onLoaded?.();
      return true;
    },
    () => false,
  );
  return loading;
}

let embedded: Promise<string> | null = null;

/** The bundled faces as base64 `@font-face` CSS for an export SVG ('' if they cannot be read). */
export function exportFontCss(): Promise<string> {
  if (!embedded) {
    embedded = Promise.all(
      HAND_FACES.map(async (f) => {
        const res = await fetch(fontUrl(f.file));
        if (!res.ok) throw new Error(`font ${res.status}`);
        return { src: `data:font/woff2;base64,${toBase64(new Uint8Array(await res.arrayBuffer()))}`, unicodeRange: f.unicodeRange };
      }),
    ).then(
      (faces) => fontFaceCss(faces),
      () => {
        embedded = null; // retry on the next export
        return '';
      },
    );
  }
  return embedded;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
