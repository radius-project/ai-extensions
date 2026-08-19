# Radius Canvas visual baselines

This directory owns the P2-A visual baseline inventory VI-01 through VI-07. The suite renders production pages through the Phase 6 loopback harness with real packaged React, React Flow, and dagre, fixed readable data, explicit host theme tokens, strict network isolation, and deterministic Chromium settings.

Run the reviewed baselines with:

```console
pnpm run test:visual
```

## Baseline update policy

Update a baseline only when a deliberate product UI change affects one of the selected states:

1. State the product reason in the pull request.
2. Run `pnpm run test:visual -- --update-snapshots` on the Ubuntu baseline runner.
3. Stage only the expected PNG files tied to that reason.
4. Review every expected, actual, and diff image at full size.
5. Run the suite twice without `--update-snapshots` before requesting review.

Do not update images to make an unexplained failure green. Do not broadly mask content, loosen pixel thresholds, accept a retry-only pass, or capture personal credentials, live repositories, cloud state, timestamps, random identifiers, or network assets. Failure traces and actual/diff images are diagnostics and are not approved baselines.

The canonical baseline uses Playwright-managed Chromium on `ubuntu-latest`, a `900 × 900` viewport, device scale `1`, UTC, `en-US`, reduced motion, DejaVu Sans, hidden carets, disabled animations, and exact pixels. Other operating systems exercise P2-B command and path behavior but do not author screenshot baselines.
