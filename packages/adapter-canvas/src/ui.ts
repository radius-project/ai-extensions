// Canvas adapter — reusable UI primitives.
//
// Small `props => htmlString` builders that encode the refreshed Radius design
// system (see the token block in ./pages/shell-styles.ts). Page renderers in
// ./pages/ compose these instead of hand-writing inline styles, so the look
// stays consistent and Figma components map 1:1 to a function here.
//
// No I/O or state — pure string builders. All colors/spacing come from the CSS
// custom properties defined in the page shell, so these never hard-code hex
// values.

import { escapeHtml } from "./shared.js";
import { ICON_APP, ICON_ENV, ICON_DEP } from "./navicons.js";

// The Radius brand mark (orange dial). `size` in px.
export function radiusMark(size = 28) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" aria-hidden="true">` +
    `<circle cx="64" cy="64" r="64" fill="var(--rad-brand, #da4c2a)"/>` +
    `<circle cx="64" cy="64" r="56" fill="var(--rad-brand-dark, #bb311e)" opacity="0.3"/>` +
    `<line x1="64" y1="64" x2="34" y2="28" stroke="#fff" stroke-width="7" stroke-linecap="round"/>` +
    `<circle cx="64" cy="64" r="8" fill="#fff"/></svg>`
  );
}

// Top-level navigation: Applications / Environments / Deployments.
// Flat bar (Figma "TabBar"): each tab is a bordered icon box + label; the active
// tab has dark bold text + an orange underline along the bottom of the bar,
// inactive tabs are muted. `active` is one of:
// 'applications' | 'environments' | 'deployments'.
export function topNav(active: string): string {
  const tabs = [
    {
      id: "applications",
      label: "Applications",
      page: "graph",
      icon: iconApplications()
    },
    {
      id: "environments",
      label: "Environments",
      page: "environment",
      icon: iconEnvironments()
    },
    {
      id: "deployments",
      label: "Deployments",
      page: "deploying",
      icon: iconDeployments()
    }
  ];
  const items = tabs
    .map((t) => {
      const cls =
        t.id === active ?
          "rad-topnav__tab rad-topnav__tab--active"
        : "rad-topnav__tab";
      return (
        `<a href="/?page=${t.page}" class="${cls}">` +
        `<span class="rad-topnav__icon">${t.icon}</span>` +
        `<span class="rad-topnav__label">${t.label}</span></a>`
      );
    })
    .join("");
  const chip =
    `<a class="rad-opchip" id="rad-opchip" href="/?page=environment" hidden` +
    ` aria-live="polite" title="View environment setup">` +
    `<span class="rad-opchip__dot" id="rad-opchip-dot" aria-hidden="true"></span>` +
    `<span class="rad-opchip__label" id="rad-opchip-label"></span></a>`;
  return `<nav class="rad-topnav">${items}${chip}</nav>`;
}

// Underlined sub-tabs (e.g. Modeled / Planned / Deployed / Diff).
// `items` = [{ id, label }], `active` = id, `onNav` = optional JS nav fn name.
export interface SubTab {
  id: string;
  label: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export function subTabs(
  items: readonly SubTab[],
  active: string,
  onNav = "radiusNavTo"
): string {
  const links = items
    .map((it) => {
      const cls =
        it.id === active ? "rad-subtab rad-subtab--active" : "rad-subtab";
      return `<a href="?page=${it.id}" data-page="${
        it.id
      }" class="${cls}" onclick="${onNav}(event, '${it.id}')">${escapeHtml(
        it.label
      )}</a>`;
    })
    .join("");
  return `<nav class="rad-subtabs" id="graph-nav">${links}</nav>`;
}

// Page heading with the brand mark.
export function heading(title: string, subtitleHtml = ""): string {
  const sub = subtitleHtml ? `<p class="rad-lede">${subtitleHtml}</p>` : "";
  return `<div class="rad-heading"><h1>${radiusMark(26)}<span>${escapeHtml(
    title
  )}</span></h1>${sub}</div>`;
}

// Labeled form field wrapper.
export function field(label: string, controlHtml: string): string {
  return `<div class="rad-field"><label>${escapeHtml(
    label
  )}</label>${controlHtml}</div>`;
}

// Native select. `options` = [{ value, label }] or a raw <option> string.
export function select(
  id: string,
  options: readonly SelectOption[] | string,
  attrs = ""
): string {
  const opts =
    Array.isArray(options) ?
      options
        .map(
          (o) =>
            `<option value="${escapeHtml(o.value)}">${escapeHtml(
              o.label
            )}</option>`
        )
        .join("")
    : String(options);
  return `<select id="${id}" class="rad-select" ${attrs}>${opts}</select>`;
}

// Button. `variant`: 'primary' (green, default) | 'brand' | 'neutral'.
export function button(
  id: string,
  label: string,
  variant = "primary",
  attrs = ""
): string {
  return `<button id="${id}" class="rad-btn rad-btn--${variant}" ${attrs}>${escapeHtml(
    label
  )}</button>`;
}

// Status banner. `kind`: 'info' | 'success' | 'error'.
export function statusPill(id: string, kind: string, html: string): string {
  return `<div id="${id}" class="rad-status rad-status--${kind}">${html}</div>`;
}

// Floating feedback widget (bottom-right). A dark round chat button that toggles
// a small popover with "Share feedback" and "Learn about Radius" links. Rendered
// once in the page shell so it appears on every page.
export function feedbackWidget(): string {
  const chat =
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
    `<path d="M12 3C6.48 3 2 6.94 2 11.5c0 2.3 1.14 4.36 2.98 5.84L4 21l4.2-1.9c1.16.38 2.44.6 3.8.6 5.52 0 10-3.94 10-8.7S17.52 3 12 3z" ` +
    `stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<circle cx="8.5" cy="11.5" r="1.1" fill="currentColor"/><circle cx="12" cy="11.5" r="1.1" fill="currentColor"/><circle cx="15.5" cy="11.5" r="1.1" fill="currentColor"/></svg>`;
  const feedbackUrl =
    "https://github.com/radius-project/ai-extensions/issues/new?template=feedback-or-bug-report.yml";
  const learnUrl = "https://radapp.io";
  return `<div id="rad-feedback" class="rad-feedback">
  <div id="rad-feedback-pop" class="rad-feedback__pop" style="display:none;">
    <a class="rad-feedback__link" href="${feedbackUrl}" target="_blank" rel="noopener noreferrer" title="${feedbackUrl}">Share feedback</a>
    <a class="rad-feedback__link" href="${learnUrl}" target="_blank" rel="noopener noreferrer" title="${learnUrl}">Learn about Radius</a>
  </div>
  <button id="rad-feedback-btn" class="rad-feedback__btn" type="button" aria-label="Share feedback" aria-haspopup="dialog" aria-expanded="false">${chat}</button>
</div>
<script>
(function(){
  var btn = document.getElementById('rad-feedback-btn');
  var pop = document.getElementById('rad-feedback-pop');
  if (!btn || !pop) return;
  function toggle(show){
    var open = show === undefined ? pop.style.display === 'none' : show;
    pop.style.display = open ? 'flex' : 'none';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  btn.addEventListener('click', function(e){ e.stopPropagation(); toggle(); });
  document.addEventListener('click', function(e){
    if (!document.getElementById('rad-feedback').contains(e.target)) toggle(false);
  });
})();
</script>`;
}

// A resource node card used in the app graph (icon + title + type label).
export function nodeCard(
  title: string,
  typeLabel: string,
  iconHtml?: string
): string {
  return (
    `<div class="rad-node">` +
    `<div class="rad-node__head"><span class="rad-node__icon">${
      iconHtml || ""
    }</span>` +
    `<span class="rad-node__title">${escapeHtml(title)}</span></div>` +
    `<div class="rad-node__type">${escapeHtml(typeLabel)}</div>` +
    `</div>`
  );
}

// --- Nav icons — the exact artwork from the Figma file (Applications page) -----
// Each is a black line-art PNG exported from Figma, applied as a CSS mask so it
// paints in `currentColor` and therefore follows the pill's theme + active state.
// `fit` is the mask-size: 'contain' fits the whole PNG (used for the square
// 96×96 icons); 'cover' scales to fill the box height and crops transparent
// side padding (used for the wide 96×48 deployments icon so its glyph renders at
// the same visual height as the square ones instead of appearing half-size).
// A nav icon glyph. Painted in the theme's default text color (via a CSS mask)
// so it stays legible in light/dark and does NOT dim on inactive tabs — only the
// label changes color for the active/inactive state (matches Figma).
function navIcon(dataUri: string, size = 28, fit = "contain"): string {
  return (
    `<span aria-hidden="true" style="display:inline-block;width:${size}px;height:${size}px;` +
    `background-color:var(--rad-text, currentColor);` +
    `-webkit-mask:url(${dataUri}) center/${fit} no-repeat;` +
    `mask:url(${dataUri}) center/${fit} no-repeat;"></span>`
  );
}
function iconApplications() {
  return navIcon(ICON_APP);
}
function iconEnvironments() {
  return navIcon(ICON_ENV);
}
function iconDeployments() {
  return navIcon(ICON_DEP, 28, "cover");
}
