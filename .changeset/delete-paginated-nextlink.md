---
"radius": patch
---

Document the fix for `rad app delete` failing on applications with more than one page of resources of a single type. The control plane returned a paginated `nextLink` that was an absolute cluster-internal URL (`http://dynamic-rp.radius-system:8082/...`), which the CLI dialed verbatim — bypassing the Kubernetes API-server proxy and failing DNS resolution on the runner, so the delete aborted during enumeration before removing anything. The shared `delete-resource` composite action now aliases the control-plane services onto loopback before the delete step, and the `radius-delete` skill describes the step and the `no such host` failure mode.
