/**
 * Framework-free icon source (path data + plain SVG string building) —
 * importable both from the renderer (`renderer/icons.mjs` builds real DOM
 * elements from it) and from the main process (`main.js` builds rasterized
 * `NativeImage`s from it for native context menus, which can't embed inline
 * SVG). Analogous to `src/model/`: no pdf.js/pdf-lib/Electron import here,
 * so the exact same source is usable in both processes without a bundler.
 *
 * Path data manually copied from `@tabler/icons` (outline variant), version
 * 3.46.0 (`node_modules/@tabler/icons/icons/outline/<name>.svg`) — MIT
 * licensed, see `node_modules/@tabler/icons/LICENSE`. `@tabler/icons` is
 * deliberately only a `devDependency` (see package.json): the package is
 * ~50 MB with every icon variant/format, but we only need twelve individual
 * icons from it — those are copied over "by hand" once here instead
 * of dragging the whole package along at runtime. When adding a new icon:
 * open the matching file in `node_modules/@tabler/icons/icons/outline/`,
 * enter every `<path d="...">` value EXCEPT the first (in every Tabler
 * icon, that's an invisible `stroke="none" fill="none"` background
 * rectangle for a uniform bounding box, purely decorative, deliberately
 * left out here) under the icon's name here.
 */

export const ICON_VIEWBOX = '0 0 24 24';

export const ICONS = {
  x: {
    paths: ['M18 6l-12 12', 'M6 6l12 12'],
  },
  copy: {
    paths: [
      'M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666',
      'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1',
    ],
  },
  trash: {
    paths: [
      'M4 7l16 0',
      'M10 11l0 6',
      'M14 11l0 6',
      'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12',
      'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3',
    ],
  },
  // "rotate left" (counterclockwise) — Tabler simply calls the base variant
  // without a suffix "rotate", its clockwise counterpart "rotate-clockwise"
  // (see below). No risk of confusion with a generic "rotate" icon, since
  // the app only knows these two directions.
  rotate: {
    paths: ['M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5'],
  },
  'rotate-clockwise': {
    paths: ['M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5'],
  },
  'layout-columns': {
    paths: [
      'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
      'M12 4l0 16',
    ],
  },
  'layout-grid': {
    paths: [
      'M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
      'M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
      'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
      'M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
    ],
  },
  'device-floppy': {
    paths: [
      'M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2',
      'M10 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
      'M14 4l0 4l-6 0l0 -4',
    ],
  },
  'folder-open': {
    paths: [
      'M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2',
    ],
  },
  keyboard: {
    paths: [
      'M2 8a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2l0 -8',
      'M6 10l0 .01',
      'M10 10l0 .01',
      'M14 10l0 .01',
      'M18 10l0 .01',
      'M6 14l0 .01',
      'M18 14l0 .01',
      'M10 14l4 .01',
    ],
  },
  file: {
    paths: ['M14 3v4a1 1 0 0 0 1 1h4', 'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2'],
  },
  settings: {
    paths: [
      'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065',
      'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
    ],
  },
};

// Central default values (this phase's concept: ONE place for stroke width
// and color). `renderer/icons.mjs` instead overrides the color via CSS
// (custom property `--icon-color`, cascaded/overridable per instance) —
// this JS default here is only relevant for the main process, which has no
// CSS and calls `buildSvgMarkup()` directly with hard-baked attribute
// values (rasterization for native context menus, see main.js).
export const ICON_DEFAULTS = {
  strokeWidth: 2,
  color: '#cccccc',
};

/**
 * Builds plain SVG markup as a string — for contexts without a DOM (main
 * process: rasterization to PNG for native menus, see main.js). The
 * renderer instead uses `createIcon()` from `renderer/icons.mjs`, which
 * builds real DOM nodes (no `innerHTML` in the rest of the codebase, see
 * the comment there).
 */
export function buildSvgMarkup(name, { size = 24, color = ICON_DEFAULTS.color, strokeWidth = ICON_DEFAULTS.strokeWidth } = {}) {
  const def = ICONS[name];
  if (!def) throw new Error(`Unknown icon: ${name}`);
  const pathsMarkup = def.paths.map((d) => `<path d="${d}" />`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${ICON_VIEWBOX}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${pathsMarkup}</svg>`;
}
