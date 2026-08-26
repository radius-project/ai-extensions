---
"radius": patch
---

Fix `rad app delete` failing for applications with more than one page of resources of a single type. The control plane returns a paginated `nextLink` that is an absolute cluster-internal URL (`http://dynamic-rp.radius-system:8082/...`), which the CLI dials verbatim — bypassing the Kubernetes API-server proxy and failing DNS resolution on the runner, so the delete aborted during enumeration before removing anything. The generated delete workflow now port-forwards the control-plane services onto loopback and aliases their in-cluster DNS names immediately before the delete step, so a directly dialed `nextLink` still reaches the control plane.
