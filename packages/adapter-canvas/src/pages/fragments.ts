// Canvas adapter — markup fragments shared by more than one page renderer.

function deploymentDialogHtml(
  action: "delete" | "abandon",
  opening: string,
  title: string
): string {
  const id = `deploy-${action}`;
  return `${opening} style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:50; align-items:center; justify-content:center;">
  <div class="rad-ddlg" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
    <div class="rad-ddlg__header">
      <span class="rad-ddlg__title" id="${id}-title">${title}</span>
      <button type="button" class="rad-ddlg__close" id="${id}-close" aria-label="Close">✕</button>
    </div>
    <div class="rad-ddlg__info">
      <span class="rad-ddlg__info-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg></span>
      <span class="rad-ddlg__app" id="${id}-app"></span>
      <span class="rad-ddlg__env">Environment: <strong id="${id}-env"></strong></span>
    </div>
    <div class="rad-ddlg__content" id="${id}-body"></div>
  </div>
</div>`;
}

// Delete confirmation dialog (Figma 3-step type-to-confirm flow), shared by
// every page that can delete a deployment. Tearing down live infrastructure is
// irreversible, so a page must never ship a lighter-weight confirmation of its
// own — that would quietly lower the bar for the whole product. The step
// behaviour lives in radiusCreateDeleteDeploymentDialog (client.ts).
export const DELETE_DEPLOYMENT_DIALOG_HTML = deploymentDialogHtml(
  "delete",
  '<div id="deploy-delete-modal"',
  "Delete Deployment"
);

export const ABANDON_DEPLOYMENT_DIALOG_HTML = deploymentDialogHtml(
  "abandon",
  '<div id="deploy-abandon-modal"',
  "Stop Tracking Deployment"
);

// Shared by both render paths of the Diff pane (empty selection and rendered
// graph) so the two copies of the markup cannot drift apart.
export const GRAPH_DIFF_SUBTITLE = `<p class="rad-lede" id="graph-diff-subtitle" style="margin:0 0 20px;">The application graph diff compares the application model between branches, allowing you to visualize changes in your application to reveal added, removed, or modified components. Use it to review the impact of a pull request before it is merged.</p>`;
