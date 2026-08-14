// DOM icon factory for the renderer — builds real `<svg>` elements from the
// shared, framework-free path source in `src/icons.mjs` (the same source
// main.js uses to build the rasterized context-menu icons, see the comment
// there). No `innerHTML`, consistent with the rest of renderer.js (the only
// `innerHTML` use there is plain clearing via `= ''`, never markup
// assignment).
//
// Central stroke width/color run through CSS custom properties
// (`--icon-stroke-width`/`--icon-color`, see the `.icon` rule in
// index.html) instead of SVG attributes — that's the one central place
// where both can be changed for ALL icons at once. An individual color per
// icon instance only overrides the same custom property locally on that
// one `<svg>` element (CSS cascade), no second mechanism needed.
import { ICONS, ICON_VIEWBOX } from '../src/icons.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createIcon(name, { size = 15, color } = {}) {
  const def = ICONS[name];
  if (!def) throw new Error(`Unknown icon: ${name}`);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', ICON_VIEWBOX);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  if (color) svg.style.setProperty('--icon-color', color);

  for (const d of def.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
