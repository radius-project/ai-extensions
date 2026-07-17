// Canvas adapter — reusable UI primitives.
//
// Small `props => htmlString` builders that encode the refreshed Radius design
// system (see the token block in ./pages.mjs `pageShell`). Page renderers in
// ./pages.mjs compose these instead of hand-writing inline styles, so the look
// stays consistent and Figma components map 1:1 to a function here.
//
// No I/O or state — pure string builders. All colors/spacing come from the CSS
// custom properties defined in pageShell, so these never hard-code hex values.

import { escapeHtml } from "./shared.mjs";
import { ICON_APP, ICON_ENV, ICON_DEP } from "./navicons.mjs";

// The Radius brand mark (orange dial). `size` in px.
export function radiusMark(size = 28) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" aria-hidden="true">`
        + `<circle cx="64" cy="64" r="64" fill="var(--rad-brand, #da4c2a)"/>`
        + `<circle cx="64" cy="64" r="56" fill="var(--rad-brand-dark, #bb311e)" opacity="0.3"/>`
        + `<line x1="64" y1="64" x2="34" y2="28" stroke="#fff" stroke-width="7" stroke-linecap="round"/>`
        + `<circle cx="64" cy="64" r="8" fill="#fff"/></svg>`;
}

// Top-level segmented pill navigation: Applications / Environments / Deployments.
// `active` is one of: 'applications' | 'environments' | 'deployments'.
export function topNav(active) {
    const tabs = [
        { id: 'applications', label: 'Applications', page: 'graph', icon: iconApplications() },
        { id: 'environments', label: 'Environments', page: 'environment', icon: iconEnvironments() },
        { id: 'deployments', label: 'Deployments', page: 'deploying', icon: iconDeployments() },
    ];
    const items = tabs.map(t => {
        const cls = t.id === active ? 'rad-topnav__pill rad-topnav__pill--active' : 'rad-topnav__pill';
        return `<a href="/?page=${t.page}" class="${cls}">${t.icon}<span>${t.label}</span></a>`;
    }).join('');
    return `<nav class="rad-topnav">${items}</nav>`;
}

// Underlined sub-tabs (e.g. Modeled / Planned / Deployed / Diff).
// `items` = [{ id, label }], `active` = id, `onNav` = optional JS nav fn name.
export function subTabs(items, active, onNav = 'radiusNavTo') {
    const links = items.map(it => {
        const cls = it.id === active ? 'rad-subtab rad-subtab--active' : 'rad-subtab';
        return `<a href="?page=${it.id}" data-page="${it.id}" class="${cls}" onclick="${onNav}(event, '${it.id}')">${escapeHtml(it.label)}</a>`;
    }).join('');
    return `<nav class="rad-subtabs" id="graph-nav">${links}</nav>`;
}

// Page heading with the brand mark.
export function heading(title, subtitleHtml = '') {
    const sub = subtitleHtml ? `<p class="rad-lede">${subtitleHtml}</p>` : '';
    return `<div class="rad-heading"><h1>${radiusMark(26)}<span>${escapeHtml(title)}</span></h1>${sub}</div>`;
}

// Labeled form field wrapper.
export function field(label, controlHtml) {
    return `<div class="rad-field"><label>${escapeHtml(label)}</label>${controlHtml}</div>`;
}

// Native select. `options` = [{ value, label }] or a raw <option> string.
export function select(id, options, attrs = '') {
    const opts = Array.isArray(options)
        ? options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')
        : String(options);
    return `<select id="${id}" class="rad-select" ${attrs}>${opts}</select>`;
}

// Button. `variant`: 'primary' (green, default) | 'brand' | 'neutral'.
export function button(id, label, variant = 'primary', attrs = '') {
    return `<button id="${id}" class="rad-btn rad-btn--${variant}" ${attrs}>${escapeHtml(label)}</button>`;
}

// Status banner. `kind`: 'info' | 'success' | 'error'.
export function statusPill(id, kind, html) {
    return `<div id="${id}" class="rad-status rad-status--${kind}">${html}</div>`;
}

// A resource node card used in the app graph (icon + title + type label).
export function nodeCard(title, typeLabel, iconHtml) {
    return `<div class="rad-node">`
        + `<div class="rad-node__head"><span class="rad-node__icon">${iconHtml || ''}</span>`
        + `<span class="rad-node__title">${escapeHtml(title)}</span></div>`
        + `<div class="rad-node__type">${escapeHtml(typeLabel)}</div>`
        + `</div>`;
}

// --- Nav icons — the exact artwork from the Figma file (Applications page) -----
// Each is a black line-art PNG exported from Figma, applied as a CSS mask so it
// paints in `currentColor` and therefore follows the pill's theme + active state.
// `fit` is the mask-size: 'contain' fits the whole PNG (used for the square
// 96×96 icons); 'cover' scales to fill the box height and crops transparent
// side padding (used for the wide 96×48 deployments icon so its glyph renders at
// the same visual height as the square ones instead of appearing half-size).
function navIcon(dataUri, size = 22, fit = 'contain') {
    return `<span aria-hidden="true" style="display:inline-block;width:${size}px;height:${size}px;`
        + `background-color:currentColor;`
        + `-webkit-mask:url(${dataUri}) center/${fit} no-repeat;`
        + `mask:url(${dataUri}) center/${fit} no-repeat;"></span>`;
}
function iconApplications() { return navIcon(ICON_APP); }
function iconEnvironments() { return navIcon(ICON_ENV); }
function iconDeployments() { return navIcon(ICON_DEP, 22, 'cover'); }
