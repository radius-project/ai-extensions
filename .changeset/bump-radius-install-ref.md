---
"radius": patch
---

Pin the Radius CLI install script used by the ephemeral control-plane setup action to the immutable commit containing the sudo escalation fix. This prevents the installer from creating a root-owned `$HOME/.local/bin` that blocks later user-owned tool installs such as `yq`.
