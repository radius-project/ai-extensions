---
"@radius-project/canvas": patch
---

Document the Radius `rad` execution boundary in the modeling and graph skills: the canvas extension is the only component that runs `rad`, honoring `RADIUS_RAD_BINARY` when configured and otherwise using the managed binary under `~/.radius/ai-extensions/bin` (downloaded when absent and upgraded when older than the latest release). The skills now prohibit agent-side `rad` execution via PowerShell, a shell, a subprocess, or a delegated agent, and require diagnosing failures through the extension log rather than reproducing them with a direct CLI command.
