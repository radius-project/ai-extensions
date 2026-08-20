# Package browser libraries with Radius Canvas

- **Author**: Nicole James (@nicolejms)
- **Date**: 2026-08
- **Status**: Draft

## Overview

Radius Canvas uses five third-party files to draw application graphs: React, ReactDOM, React Flow, React Flow styles, and dagre. Today, Radius downloads these files from unpkg when the first canvas opens, keeps them in memory, and adds them to each page. The current code is in [`vendor.ts`](../../packages/adapter-canvas/src/vendor.ts).

This design recommends including these files in the published Radius package instead. Users would receive everything needed to open and use the canvas without depending on unpkg or an internet connection.

GitHub does not publish a rule that canvas extensions must avoid public download services. However, GitHub's public examples strongly favor self-contained extensions. A review of the 23 canvas extensions in [`github/awesome-copilot`](https://github.com/github/awesome-copilot/tree/main/extensions) found one that refers to unpkg or jsDelivr. GitHub's [canvas documentation](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions) also describes extensions as directories containing their entry file, dependencies, and optional local files.

## Design

### Option 1: Continue downloading from unpkg

**Advantages**

- Keeps the published Radius package smaller.
- Requires little change to the current code.

**Disadvantages**

- Every new Radius session depends on internet access and unpkg.
- Opening the first canvas can be slower while five files are downloaded.
- A network failure can prevent graph rendering.
- A fixed URL names a version but does not prove that the downloaded file is unchanged.

### Option 2: Include the files with Radius

**Advantages**

- Works offline and on restricted networks.
- Removes an outside service from canvas startup.
- Ships the exact files used by automated tests.
- Makes library changes part of normal code review and release work.

**Disadvantages**

- Increases the canvas file by about 0.59 MB, from about 1.04 MB to 1.63 MB, based on the five versions used today. When compressed for download, the estimated increase is about 0.16 MB, from 0.28 MB to 0.44 MB. The final result may vary slightly after the build changes.
- Requires build and package updates.
- Requires the project to include the correct third-party license notices.

### Recommendation

Choose option 2 and include the five files with Radius. Reliability and predictable releases are more important than the modest package-size savings from downloading them later. This also follows the dominant pattern in GitHub's public canvas examples, while recognizing that GitHub does not make it a formal requirement.

### What changes

- Replace the unpkg download in [`vendor.ts`](../../packages/adapter-canvas/src/vendor.ts) with files included during the Radius build.
- Keep [`pages/shell.ts`](../../packages/adapter-canvas/src/pages/shell.ts) responsible for adding the files to each page.
- Update [`build.mjs`](../../packages/adapter-canvas/build.mjs) to include the five files in `extension.mjs`.
- Keep the existing one-file canvas package.
- Record required third-party notices in the published package.
- Stop the build with a clear error if any required file is missing.

## Test plan

- Build and open graph pages with all outside network access blocked.
- Confirm graph details, links, layout, and navigation still work.
- Confirm the published canvas contains all five files and no unpkg address.
- Confirm a missing or changed source file fails the build clearly.
- Keep browser tests independent of public internet services.

## Security

Radius will use fixed, reviewed versions of the five files. Updates will go through normal code review and automated checks. Including the files removes the risk of running code downloaded from a public service each time Radius starts.
