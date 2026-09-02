# Radius Canvas

The Radius canvas extension for the GitHub Copilot app. It ships inside the [`radius` plugin](../../plugins/radius/README.md) — install that to get it.

## What it does

- **Applications.** Renders the repository as a live Radius application graph, with modeled, planned, deployed, and branch-diff views.
- **Modeling.** Generates and repairs the `.radius/app.bicep` definition from the repository's contents.
- **Environments.** Creates an AWS or Azure deploy environment together with the OIDC trust GitHub Actions needs, then verifies it.
- **Deployments.** Deploys and deletes applications through the generated GitHub Actions workflows, and reports progress on the canvas.

## Assets

- `assets/preview.png` — primary gallery image required by the [Awesome Copilot canvas-extension guide](https://github.com/github/awesome-copilot/blob/main/CONTRIBUTING.md#adding-canvas-extensions).
