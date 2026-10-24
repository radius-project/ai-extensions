---
"radius": patch
---

**Fixed:** Prepare deployments from the selected branch's committed application file, honor an explicitly selected Bicep path, and stop when branch access, source reads, secret provisioning or workflow publication cannot be confirmed. Refuse deployment when existing workflow files cannot be synchronized instead of dispatching stale workflows. Commit and push application changes before deploying; preparation no longer substitutes stale environment commands or overwrites secrets after an unreadable listing.
