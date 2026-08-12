---
"radius": minor
---

Make the Applications tab explain itself and adapt its primary action to the state the user is actually in, instead of showing one static button that may not be the next useful step:

- Each sub-tab now carries a subtitle describing what it shows. The Modeled lede links "Modeled", "Planned", "Deployed", and "Diff" to their respective tabs so the four views are discoverable from the first one.
- The Modeled, Planned, and Deployed tabs resolve their primary button from the environments and deployments that exist. With no environment it becomes "Create Environment" and links straight to the creation form; with an environment but no deployment it becomes "Deploy Application"; on the Deployed tab, once a deployment exists it becomes "Delete Deployment". Each subtitle gains a matching hint naming the selected application and environment in bold, so the button's effect is stated before it is clicked. A failed deployment counts as deployed, since its infrastructure still needs cleaning up.
- Deleting from the Deployed tab now goes through the same three-step type-to-confirm dialog as the Deployments tab, rather than a single click. The markup, styling, and behavior live in one place (`DELETE_DEPLOYMENT_DIALOG_HTML` and `radiusCreateDeleteDeploymentDialog`) so the two entry points cannot drift; each page keeps only its own dispatch. The button is disabled and relabeled while a delete is in flight, and a bounded poll re-enables it when the delete resolves.
- The Planned tab's Deploy button requires an explicit branch and environment. An empty branch was not inert — the server resolved it to the repository's default branch, so a premature click could deploy something other than the graph on screen. `radiusDeployPlannedApp` rejects an empty branch too, so the dispatch path does not rely on button state alone.
- The Application, Branch, and Environment selectors preselect sensible defaults and re-render the planned graph whenever any of them changes, so the graph always matches the current selection.

Graph lines are also easier to read: node borders and edges are thicker, and they no longer route through the host's inverted border tokens, which had made "strong" strokes fainter than the default ones. Weights are now derived from the text color so they hold up in both light and dark themes.
