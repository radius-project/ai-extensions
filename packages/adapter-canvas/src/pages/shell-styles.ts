// Canvas adapter — the document shell stylesheet. Held as one fragment of the
// shared shell (./shell.ts) so every page inherits the same Radius design
// tokens, host theme mapping, and component styles.

export const SHELL_STYLE_CSS = `  /* ─── Radius design tokens (from Figma variables) ─────────────────────── */
  :root {
    /* The Copilot host owns theme selection and injects these semantic tokens.
       Radius keeps no competing preference; all theme-sensitive colors flow
       through this layer so host changes update the open canvas immediately. */
    color-scheme: var(--color-scheme, inherit);
    --rad-brand: #da4c2a;
    --rad-brand-dark: #bb311e;
    --rad-primary: #238741;
    --rad-primary-hover: #1f7539;
    --rad-bg: var(--background-color-default, Canvas);
    --rad-surface: var(--background-color-default, Canvas);
    --rad-text: var(--text-color-default, CanvasText);
    --rad-text-secondary: var(--text-color-default, CanvasText);
    --rad-text-tertiary: var(--text-color-muted, color-mix(in srgb, CanvasText 70%, Canvas));
    /* Some host segmented-control tokens retain their light palette in a dark
       canvas. Derive neutral layers from the active host surface and text so
       navigation, graph wells, and secondary buttons always stay in-theme. */
    --rad-bg-subtle: color-mix(in srgb, var(--rad-text) 6%, var(--rad-bg));
    --rad-bg-selected: color-mix(in srgb, var(--rad-text) 12%, var(--rad-bg));
    --rad-bg-hover: color-mix(in srgb, var(--rad-text) 16%, var(--rad-bg));
    --rad-stroke: var(--border-color-default, color-mix(in srgb, var(--rad-text) 20%, var(--rad-bg)));
    --rad-stroke-strong: var(--border-color-muted, color-mix(in srgb, var(--rad-text) 45%, var(--rad-bg)));
    --rad-neutral-bg: var(--rad-bg-subtle);
    --rad-neutral-bg-hover: var(--rad-bg-selected);
    --rad-neutral-border: var(--rad-stroke);
    --rad-neutral-text: var(--rad-text);
    --rad-link: var(--text-color-accent, #0969da);
    --rad-link-hover: var(--text-color-accent-emphasis, #0550ae);
    --rad-info: var(--text-color-accent, #0969da);
    /* Status colors are read as text on the active surface, so they cannot be
       used exactly as the host supplies them: a host may keep its light-theme
       status palette in a dark canvas (the same issue the neutral layers above
       work around), leaving mid-dark amber or green on a dark background. Mix
       each toward the active text color to keep the hue while pinning contrast
       to the theme — the mix lightens in a dark canvas and darkens in a light
       one. Solid fills that carry white text use the raw *-solid tokens below
       instead, because those must not follow the surface. */
    --rad-success: color-mix(in srgb, var(--text-color-success, #1a7f37) 60%, var(--rad-text));
    --rad-warning: color-mix(in srgb, var(--text-color-warning, #9a6700) 60%, var(--rad-text));
    --rad-danger: color-mix(in srgb, var(--text-color-danger, #cf222e) 60%, var(--rad-text));
    --rad-success-solid: #1a7f37;
    --rad-warning-solid: #9a6700;
    --rad-danger-text: var(--rad-danger);
    --rad-danger-solid: #c72222;
    --rad-danger-solid-border: #a61a1a;
    --rad-info-bg: color-mix(in srgb, var(--rad-info) 14%, var(--rad-surface));
    --rad-success-bg: color-mix(in srgb, var(--rad-success) 14%, var(--rad-surface));
    --rad-warning-bg: color-mix(in srgb, var(--rad-warning) 16%, var(--rad-surface));
    --rad-danger-bg: color-mix(in srgb, var(--rad-danger) 14%, var(--rad-surface));
    --rad-node-bg: var(--rad-surface);
    /* Graph lines are data, not chrome, so they deliberately do NOT flow
       through the host's border tokens: --border-color-muted is *fainter*
       than --border-color-default in Primer, which made --rad-stroke-strong
       resolve to the weakest line on the canvas. Mixing the active text
       colour into the active background instead keeps a consistent contrast
       ratio and inverts correctly in dark mode (light lines on a dark
       canvas) without needing a second palette. */
    --rad-node-border: color-mix(in srgb, var(--rad-text) 45%, var(--rad-bg));
    --rad-edge: color-mix(in srgb, var(--rad-text) 55%, var(--rad-bg));
    --rad-edge-muted: color-mix(in srgb, var(--rad-text) 38%, var(--rad-bg));
    --rad-grid: color-mix(in srgb, var(--rad-text) 14%, var(--rad-bg));
    --rad-code-bg: var(--rad-bg-subtle);
    --rad-code-text: var(--rad-text);
    --rad-shadow: color-mix(in srgb, var(--rad-text) 18%, transparent);
    --rad-radius: 6px;
    --rad-radius-lg: 10px;
    --rad-font: 'Mona Sans', var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --rad-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: var(--rad-font);
    font-size: 14px;
    line-height: 20px;
    background: var(--rad-bg);
    color: var(--rad-text);
    display: flex;
    flex-direction: column;
  }

  /* ─── Top nav (Figma TabBar) ──────────────────────────────────────────── */
  .rad-topnav {
    display: flex;
    align-items: stretch;
    gap: 40px;
    padding: 0 20px;
    background: var(--rad-bg-subtle);
    border-bottom: 1px solid var(--rad-stroke);
    flex: 0 0 auto;
  }
  .rad-topnav__tab {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 4px 11px;
    color: var(--rad-text-tertiary);
    text-decoration: none;
    font-weight: 600;
    font-size: 15px;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
    transition: color 0.15s;
  }
  .rad-topnav__tab:hover { color: var(--rad-text); }
  .rad-topnav__tab--active { color: var(--rad-text); font-weight: 700; border-bottom-color: var(--rad-brand); }
  .rad-topnav__icon {
    flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    border-radius: 8px;
    background: transparent;
  }
  .rad-topnav__label { white-space: nowrap; }
  /* Ambient progress chips. They sit at the far end of the nav bar,
     deliberately quiet: they are a signal, not a summons. Nothing here moves
     the page or takes focus. The row holds the alignment so a second chip
     appearing beside the first does not push it away. */
  .rad-topnav__chips {
    margin-left: auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .rad-opchip {
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 280px;
    padding: 5px 12px;
    border: 1px solid var(--rad-stroke);
    border-radius: 999px;
    background: var(--rad-surface);
    color: var(--rad-text-secondary);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }
  .rad-opchip[hidden] { display: none; }
  .rad-opchip:hover { border-color: var(--rad-brand); color: var(--rad-text); }
  .rad-opchip__label { overflow: hidden; text-overflow: ellipsis; }
  .rad-opchip__dot {
    flex: 0 0 auto;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--rad-text-tertiary);
  }
  .rad-opchip--running .rad-opchip__dot { background: var(--rad-brand); animation: rad-opchip-pulse 1.6s ease-in-out infinite; }
  .rad-opchip--done .rad-opchip__dot { background: var(--rad-success-solid, var(--rad-info)); }
  .rad-opchip--warn .rad-opchip__dot { background: var(--rad-warning); }
  .rad-opchip--failed .rad-opchip__dot { background: var(--rad-danger); }
  @keyframes rad-opchip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) {
    .rad-opchip--running .rad-opchip__dot { animation: none; }
  }

  .main-content {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px;
    min-width: 0;
  }

  /* ─── Headings ────────────────────────────────────────────────────────── */
  .rad-heading { margin-bottom: 20px; }
  .rad-heading h1, h1 {
    display: flex; align-items: center; gap: 10px;
    font-size: 24px; font-weight: 700; letter-spacing: -0.01em;
    color: var(--rad-text); margin-bottom: 8px;
  }
  .rad-lede { color: var(--rad-text-tertiary); font-weight: 300; font-size: 15px; line-height: 22px; max-width: 720px; }
  .rad-lede strong, .rad-lede b { font-weight: 500; color: var(--rad-text-secondary); }
  .rad-lede-link { color: var(--rad-link); text-decoration: none; border-bottom: 1px solid transparent; }
  .rad-lede-link strong { color: inherit; }
  .rad-lede-link:hover, .rad-lede-link:focus-visible { color: var(--rad-link-hover); border-bottom-color: currentColor; }
  .rad-lede-link:focus-visible { outline: 2px solid var(--rad-link); outline-offset: 2px; border-radius: 2px; }
  h2 { font-size: 16px; font-weight: 600; margin: 16px 0 8px; }

  /* ─── Sub-tabs (underlined) ───────────────────────────────────────────── */
  .rad-subtabs { display: flex; gap: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--rad-stroke); }
  .rad-subtab {
    padding: 0 2px 8px; font-size: 15px; font-weight: 500; cursor: pointer;
    color: var(--rad-text-tertiary); text-decoration: none;
    border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s;
  }
  .rad-subtab:hover { color: var(--rad-text); }
  .rad-subtab--active { color: var(--rad-text); font-weight: 700; border-bottom-color: var(--rad-brand); }

  /* ─── Status banners ──────────────────────────────────────────────────── */
  .status, .rad-status { padding: 12px 14px; border-radius: var(--rad-radius); margin: 12px 0; font-size: 13px; }
  .status.info, .rad-status--info { background: var(--rad-info-bg); border: 1px solid var(--rad-info); color: var(--rad-text); }
  .status.success, .rad-status--success { background: var(--rad-success-bg); border: 1px solid var(--rad-success); color: var(--rad-text); }
  .status.error, .rad-status--error { background: var(--rad-danger-bg); border: 1px solid var(--rad-danger); color: var(--rad-text); }

  /* ─── Graph build progress ────────────────────────────────────────────── */
  /* Shared by every graph page's progress panel. Lives here rather than in the
     graph loading fragment because the diff page renders progress without
     mounting a graph surface. */
  .rad-graph-progress { margin: 0; padding: 14px 16px; border: 1px solid var(--rad-stroke); border-radius: 10px; background: var(--rad-surface); box-shadow: 0 1px 2px var(--rad-shadow); text-align: left; }
  .rad-graph-progress__head { display: flex; align-items: flex-start; gap: 12px; }
  .rad-graph-progress__spinner { flex: 0 0 auto; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%; background: conic-gradient(var(--rad-info) 0turn 0.75turn, var(--rad-stroke) 0.75turn 1turn); animation: spin 1s linear infinite; }
  .rad-graph-progress--failed .rad-graph-progress__spinner { animation: none; background: var(--rad-danger); }
  /* State is never carried by motion or color alone. */
  @media (prefers-reduced-motion: reduce) { .rad-graph-progress__spinner { animation: none; } }
  .rad-graph-progress__headtext { flex: 1 1 auto; min-width: 0; }
  .rad-graph-progress__title { font-size: 14px; font-weight: 600; color: var(--rad-text); line-height: 1.4; }
  .rad-graph-progress__activity { font-size: 12px; color: var(--rad-text-tertiary); margin-top: 2px; line-height: 1.4; }
  .rad-graph-progress__elapsed { flex: 0 0 auto; font-size: 12px; color: var(--rad-text-tertiary); font-variant-numeric: tabular-nums; }
  .rad-graph-progress__stages { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .rad-graph-progress__stage { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--rad-text-tertiary); }
  .rad-graph-progress__stage--running { color: var(--rad-text); font-weight: 600; }
  .rad-graph-progress__stage--succeeded { color: var(--rad-text); }
  .rad-graph-progress__stage--failed { color: var(--rad-danger); }
  .rad-graph-progress__glyph { flex: 0 0 auto; width: 16px; text-align: center; font-size: 11px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ─── Legacy tabs (kept for pages not yet migrated) ───────────────────── */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--rad-stroke); margin-bottom: 16px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; user-select: none; }
  .tab.active { border-bottom-color: var(--rad-brand); color: var(--rad-text); }

  code { font-family: var(--rad-mono); font-size: 12px; background: var(--rad-code-bg); color: var(--rad-code-text); padding: 2px 6px; border-radius: 4px; }
  pre { background: var(--rad-code-bg); color: var(--rad-code-text); padding: 12px; border-radius: var(--rad-radius); overflow-x: auto; font-size: 12px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }

  /* ─── Fields, inputs, selects ─────────────────────────────────────────── */
  label { display: block; font-weight: 600; font-size: 12px; color: var(--rad-text-tertiary); margin: 10px 0 4px; }
  .rad-field { display: flex; flex-direction: column; gap: 4px; }
  .rad-field label { margin: 0; }
  input:not([type="radio"]):not([type="checkbox"]), select, .rad-select {
    width: 100%; padding: 8px 10px;
    border: 1px solid var(--rad-stroke-strong);
    border-radius: var(--rad-radius); font-size: 13px;
    background: var(--rad-bg); color: var(--rad-text);
    font-family: var(--rad-font);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--rad-text) 2%, transparent);
  }
  input:focus, select:focus, .rad-select:focus { outline: 2px solid var(--rad-brand); outline-offset: 1px; border-color: var(--rad-brand); }
  select.radius-select, .rad-select { appearance: auto; cursor: pointer; min-width: 180px; }

  /* ─── Buttons ─────────────────────────────────────────────────────────── */
  button, .verify-btn, .rad-btn {
    display: inline-block; margin-top: 16px; padding: 8px 16px;
    border: none; border-radius: var(--rad-radius);
    font-weight: 600; font-size: 13px; cursor: pointer; font-family: var(--rad-font);
    transition: background 0.15s, opacity 0.15s;
  }
  button, .verify-btn, .rad-btn--primary { background: var(--rad-primary); color: #fff; }
  button:hover, .verify-btn:hover, .rad-btn--primary:hover { background: var(--rad-primary-hover); }
  .rad-btn--brand { background: var(--rad-brand); color: #fff; }
  .rad-btn--brand:hover { background: var(--rad-brand-dark); }
  .rad-btn--neutral { background: var(--rad-neutral-bg); color: var(--rad-neutral-text); border: 1px solid var(--rad-neutral-border); }
  .rad-btn--neutral:hover { background: var(--rad-neutral-bg-hover); border-color: var(--rad-stroke-strong); }
  .rad-btn--info { background: var(--rad-info); color: #fff; }
  /* Delete buttons: neutral fill + red text, flip to a solid red on hover (Figma DeleteButton). */
  .rad-btn--danger,
  .rad-btn--danger-outline { background: var(--rad-neutral-bg); color: var(--rad-danger-text); border: 1px solid var(--rad-neutral-border); }
  .rad-btn--danger:hover,
  .rad-btn--danger-outline:hover { background: var(--rad-danger-solid); border-color: var(--rad-danger-solid-border); color: #fff; }
  .rad-select-wrap { position: relative; display: inline-block; }
  .rad-select-wrap select {
    appearance: none; -webkit-appearance: none; min-width: 230px; padding: 9px 40px 9px 12px;
    font-size: 14px; color: var(--rad-text); background: var(--rad-surface);
    border: 1px solid var(--rad-stroke); border-radius: 8px; cursor: pointer;
  }
  .rad-select-wrap::after {
    content: ""; position: absolute; right: 14px; top: 50%; width: 8px; height: 8px;
    border-right: 2px solid var(--rad-text-tertiary); border-bottom: 2px solid var(--rad-text-tertiary);
    transform: translateY(-70%) rotate(45deg); pointer-events: none;
  }
  .rad-spinner-lg { flex: 0 0 auto; width: 34px; height: 34px; border: 4px solid var(--rad-stroke); border-top-color: var(--rad-info); border-radius: 50%; animation: rad-spin 0.8s linear infinite; }
  @keyframes rad-spin { to { transform: rotate(360deg); } }
  .rad-btn--info:hover { background: var(--rad-link-hover); }
  button:disabled, .rad-btn:disabled { opacity: 0.6; cursor: default; }
  .rad-btn--primary:disabled { background: var(--rad-stroke, #d1d9e0); color: var(--rad-text-tertiary, #656d76); opacity: 1; }
  .resolved-name { font-weight: 400; color: var(--rad-primary); font-size: 12px; }

  /* ─── Cards, sections, tables (Environments/Deployments) ──────────────── */
  .rad-card {
    background: var(--rad-surface); border: 1px solid var(--rad-stroke);
    border-radius: var(--rad-radius-lg); padding: 20px 24px; margin: 0 0 20px;
  }
  .rad-card__title { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; color: var(--rad-text); margin-bottom: 4px; }
  .rad-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--rad-stroke); }
  .rad-section:first-of-type { border-top: none; padding-top: 0; margin-top: 16px; }
  .rad-section__title { font-size: 15px; font-weight: 600; color: var(--rad-text); margin-bottom: 4px; }
  .rad-section__desc { font-size: 13px; color: var(--rad-text-tertiary); margin-bottom: 8px; }
  /* Lead-in sentence under a card title. */
  .rad-card__lede { font-size: 13px; line-height: 19px; color: var(--rad-text-tertiary); margin: 6px 0 0; max-width: 640px; }
  /* Helper text tucked under a form control. */
  .rad-field__help { font-size: 12px; color: var(--rad-text-tertiary); }
  /* ─── Connection layout (GitHub ⇒ cloud federation) ─────────────────────── */
  /* Presents the two identities as the two ends of a trust: a GitHub side and a
     cloud side, joined by a direction arrow. Collapses to a stack on narrow
     panels, where the arrow rotates to point downward. */
  .rad-conn { display: grid; grid-template-columns: 1fr auto 1fr; align-items: stretch; gap: 12px; margin-top: 12px; }
  .rad-conn__side {
    display: flex; flex-direction: column; gap: 8px;
    border: 1px solid var(--rad-stroke); border-radius: var(--rad-radius);
    background: var(--rad-bg-subtle); padding: 12px 14px;
  }
  .rad-conn__badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--rad-text-tertiary);
  }
  .rad-conn__badge svg { width: 15px; height: 15px; display: block; }
  .rad-conn__arrow {
    display: flex; align-items: center; justify-content: center;
    color: var(--rad-text-tertiary); font-size: 20px; line-height: 1; padding: 0 2px;
  }
  @media (max-width: 620px) {
    .rad-conn { grid-template-columns: 1fr; }
    .rad-conn__arrow { transform: rotate(90deg); padding: 2px 0; }
  }
  .rad-link { color: var(--rad-link); text-decoration: underline; cursor: pointer; font-size: 13px; }
  .rad-link:hover { color: var(--rad-link-hover); }

  .rad-table-wrap { border: 1px solid var(--rad-stroke); border-radius: var(--rad-radius-lg); overflow-x: auto; background: var(--rad-surface); }
  .rad-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .rad-table thead th {
    text-align: left; padding: 12px 14px; font-size: 12px; font-weight: 600;
    letter-spacing: 0.03em; text-transform: uppercase; color: var(--rad-text-tertiary);
    border-bottom: 1px solid var(--rad-stroke); background: var(--rad-bg);
  }
  .rad-table thead th:last-child, .rad-table__actions { text-align: right; }
  .rad-table tbody td { padding: 12px 14px; border-top: 1px solid var(--rad-stroke); vertical-align: middle; }
  .rad-table tbody tr:first-child td { border-top: none; }
  .rad-table__env { font-weight: 700; color: var(--rad-text); }
  .rad-table__provider { color: var(--rad-text-tertiary); }
  .rad-table__creds { color: var(--rad-text-secondary); }
  .rad-table__actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; white-space: nowrap; }
  .rad-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .rad-dot--success { background: var(--rad-success); }
  .rad-dot--failed { background: var(--rad-danger); }
  .rad-dot--pending { background: var(--rad-text-tertiary); }
  .rad-dot--deleting { background: var(--rad-warning); }
  .rad-status-label { vertical-align: middle; }

  /* ─── Graph + node cards ──────────────────────────────────────────────── */
  #graph-container { width: 100%; height: 450px; border-radius: var(--rad-radius-lg); position: relative; background: var(--rad-bg-subtle); }
  #graph-container:empty { background: transparent; }
  .legend { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  .legend-swatch { width: 14px; height: 12px; border-radius: 3px; border: 2px solid var(--rad-node-border); box-sizing: border-box; }
  .rad-node {
    position: relative; width: 220px; min-height: 104px;
    background: var(--rad-surface); border: 2.5px solid var(--rad-node-border);
    border-radius: 16px; padding: 16px 18px;
    pointer-events: auto; cursor: pointer;
  }
  .rad-node__head { display: flex; align-items: center; gap: 10px; }
  .rad-node__icon { width: 40px; height: 40px; flex: none; object-fit: contain; }
  .rad-node__badge { position: absolute; right: 12px; top: 12px; width: 22px; height: 22px; object-fit: contain; pointer-events: none; }
  .rad-node__badge--progress { animation: rad-node-spin 1s linear infinite; }
  @keyframes rad-node-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .rad-node__badge--progress { animation: none; } }
  .rad-node__title { font-weight: 600; font-size: 16px; color: var(--rad-text); }
  .rad-node__type {
    width: 100%; min-width: 0; overflow: hidden; white-space: nowrap;
    font-size: 13px; line-height: 18px; color: var(--rad-text-tertiary); margin-top: 6px;
  }
  .rad-node__source {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 8px;
    font-size: 12px; font-weight: 500; color: var(--rad-link); text-decoration: none; cursor: pointer;
    pointer-events: auto; background: none; border: none; padding: 0; font-family: inherit;
    min-height: 24px;
  }
  .rad-node__source:hover { text-decoration: underline; }
  .rad-node__source-glyph { font-family: var(--rad-mono); font-weight: 600; }
  .rad-node__dots {
    position: absolute; right: 10px; bottom: 10px; margin: 0; padding: 2px 4px;
    font-size: 12px; font-weight: 700; letter-spacing: 1px; line-height: 1;
    color: var(--rad-text-tertiary); background: none; border: none; border-radius: 4px;
    cursor: pointer; pointer-events: auto;
    min-width: 24px; min-height: 24px;
  }
  .rad-node__dots:hover { background: var(--rad-bg-subtle); color: var(--rad-text); }

  .field { margin: 8px 0; }
  .field-label { font-weight: 500; color: var(--rad-text-tertiary); font-size: 12px; }
  .field-value { font-family: var(--rad-mono); font-size: 13px; margin-top: 2px; }
  .field-value.placeholder { color: var(--rad-text-tertiary); font-style: italic; }

  /* ─── Feedback widget (Figma feedback-widget) ─────────────────────────── */
  .rad-feedback { position: fixed; right: 16px; bottom: 16px; z-index: 900; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .rad-feedback__btn {
    margin: 0; width: 36px; height: 36px; border-radius: 10px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--rad-text); color: var(--rad-bg); border: none; cursor: pointer; box-shadow: 0 2px 8px var(--rad-shadow);
  }
  .rad-feedback__btn:hover { background: color-mix(in srgb, var(--rad-text) 82%, var(--rad-bg)); }
  .rad-feedback__pop {
    flex-direction: column; min-width: 180px; background: var(--rad-surface);
    border: 1px solid var(--rad-stroke); border-radius: 8px; overflow: hidden;
    box-shadow: 0 6px 20px var(--rad-shadow);
  }
  .rad-feedback__link {
    padding: 10px 14px; font-size: 13px; color: var(--rad-link); text-decoration: none; white-space: nowrap;
  }
  .rad-feedback__link + .rad-feedback__link { border-top: 1px solid var(--rad-stroke); }
  .rad-feedback__link:hover { background: var(--rad-bg-subtle); text-decoration: underline; }

  /* ─── React Flow overrides ────────────────────────────────────────────────
     React Flow ships opinionated defaults (node chrome, visible connection
     handles, a light canvas). We render our own figma .rad-node cards, so strip
     React Flow's node box and hide the handles; the card supplies all visuals. */
  .rad-flow-host { width: 100%; height: 100%; }
  .react-flow, .react-flow__renderer, .react-flow__pane {
    width: 100%; height: 100%; background: transparent;
  }
  .react-flow__node { font-family: var(--rad-font); font-size: 13px; }
  /* Custom "rad" node type: no default background/border/padding — the card owns it. */
  .react-flow__node-rad {
    background: transparent; border: none; border-radius: 0; padding: 0;
    box-shadow: none; width: auto;
  }
  .react-flow__node-rad.selected, .react-flow__node-rad:focus, .react-flow__node-rad:focus-visible {
    outline: none; box-shadow: none;
  }
  .rad-node-shell { position: relative; }
  /* Edge handles exist only so React Flow can route edges; make them invisible
     and non-interactive so they never intercept card clicks. */
  .react-flow__handle.rad-handle {
    width: 1px; height: 1px; min-width: 0; min-height: 0;
    background: transparent; border: none; opacity: 0; pointer-events: none;
  }
  .react-flow__attribution { background: transparent; font-size: 10px; }
  .react-flow__attribution a { color: var(--rad-text-tertiary); }
  .react-flow__controls { box-shadow: 0 1px 4px var(--rad-shadow); border-radius: 6px; overflow: hidden; }
  .react-flow__controls-button {
    background: var(--rad-surface); border-bottom: 1px solid var(--rad-stroke);
    color: var(--rad-text); width: 26px; height: 26px;
  }
  .react-flow__controls-button:hover { background: var(--rad-bg-subtle); }
  .react-flow__controls-button svg { fill: currentColor; }
  .react-flow__minimap { background: var(--rad-surface); border: 1px solid var(--rad-stroke); border-radius: 6px; }
  /* The dot grid is painted by React Flow onto an SVG <circle fill> PRESENTATION
     ATTRIBUTE, and Chromium does not substitute var() there — a var() passed via
     the Background "color" prop is discarded and the dots fall back to black.
     Theme it as a CSS property instead, which does resolve var(). */
  .react-flow__background circle { fill: var(--rad-grid); }
  .react-flow__background path { stroke: var(--rad-grid); }
  /* Delete confirmation dialog (Figma type-to-confirm flow). Global because
     every surface that can delete a deployment shares this one dialog. */
  .rad-ddlg { max-width:480px; width:90%; margin:0; padding:0; background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:12px; box-shadow:0 8px 24px var(--rad-shadow); overflow:hidden; }
  .rad-ddlg__header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--rad-stroke); }
  .rad-ddlg__title { font-size:16px; font-weight:600; color:var(--rad-text); }
  .rad-ddlg__close { background:none; border:none; cursor:pointer; font-size:14px; line-height:1; color:var(--rad-text-tertiary); padding:6px; border-radius:6px; }
  .rad-ddlg__close:hover { background:var(--rad-neutral-bg); }
  .rad-ddlg__info { display:flex; flex-direction:column; align-items:center; gap:4px; padding:24px 24px 16px; text-align:center; }
  .rad-ddlg__info-icon { width:40px; height:40px; display:flex; align-items:center; justify-content:center; color:var(--rad-text); }
  .rad-ddlg__app { font-size:18px; font-weight:700; color:var(--rad-text); }
  .rad-ddlg__env { font-size:14px; color:var(--rad-text-secondary); }
  .rad-ddlg__content { display:flex; flex-direction:column; gap:16px; padding:24px; }
  .rad-ddlg__text { font-size:14px; line-height:1.5; color:var(--rad-text-secondary); margin:0; }
  .rad-ddlg__btn { width:100%; box-sizing:border-box; display:flex; align-items:center; justify-content:center; padding:12px 16px; border-radius:6px; font-size:14px; cursor:pointer; border:1px solid var(--rad-stroke); background:var(--rad-neutral-bg); color:var(--rad-text); }
  .rad-ddlg__btn:hover { background:var(--rad-neutral-bg-hover); }
  .rad-ddlg__warn { display:flex; gap:10px; align-items:flex-start; background:var(--rad-warning-bg); border:1px solid var(--rad-warning); border-radius:6px; padding:12px; color:var(--rad-text); font-size:14px; line-height:1.4; }
  .rad-ddlg__bullet { display:flex; gap:12px; font-size:14px; line-height:1.5; color:var(--rad-text-secondary); }
  .rad-ddlg__bullet::before { content:""; flex:0 0 2px; align-self:stretch; background:var(--rad-stroke); border-radius:1px; }
  .rad-ddlg__confirm-label { font-size:13px; line-height:1.4; color:var(--rad-text); margin:0; }
  .rad-ddlg__input { width:100%; box-sizing:border-box; height:36px; padding:0 12px; border:1px solid var(--rad-stroke); border-radius:6px; font-size:14px; color:var(--rad-text); background:var(--rad-surface); }
  .rad-ddlg__input:focus { outline:2px solid var(--rad-info); outline-offset:1px; border-color:var(--rad-info); }
  .rad-ddlg__delete { width:100%; box-sizing:border-box; padding:10px 20px; border-radius:6px; border:none; font-size:14px; font-weight:600; color:#fff; background:var(--rad-danger-solid); cursor:pointer; }
  .rad-ddlg__delete:hover { background:var(--rad-danger-solid-border); }
  .rad-ddlg__delete:disabled { background:color-mix(in srgb, var(--rad-danger) 35%, var(--rad-surface)); cursor:default; }`;
