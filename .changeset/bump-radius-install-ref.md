---
"radius": patch
---

Sync the extension workflows with their final state in the Radius repository before the duplicated tree was removed. The ephemeral control-plane setup now pins the installer commit containing the sudo escalation fix, preventing a root-owned `$HOME/.local/bin` from blocking tools such as `yq`, and deploy-status diagnostics query preview environments instead of the legacy environment surface.
