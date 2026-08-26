---
"radius": patch
---

Point a container's "View source code" link at the code it runs instead of the file that packages it:

- The app graph skill resolved a `Radius.Compute/containers` source reference to the `Dockerfile`, so the link answered how the workload is built rather than where it is defined. It now resolves the container's entrypoint — the resource's own `command`/`args` applied over the image's `ENTRYPOINT`/`CMD`, otherwise the image defaults — and maps that container path back to a repository path through the Dockerfile's `WORKDIR` and `COPY`/`ADD`, falling back to the normal filename and content search when it does not resolve.
- A `containerImage` resource still links to its `Dockerfile`, which genuinely is that resource's definition site, so an image node and the workload node that consumes it point at distinct locations.
- `validate-bicep.mjs` now rejects a `Dockerfile`, compose file, or Helm chart as a container's `codeReference` instead of relying on the skill getting it right, including when a GitHub blob URL hides the name behind percent-encoding.
