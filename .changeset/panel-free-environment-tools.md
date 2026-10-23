---
"radius": minor
---

**Added:** Configure and verify Azure or AWS environments without opening Canvas using `radius_setup_environment`, inspect saved setup and verification with `radius_environment_status`, and resume or control that same operation with `radius_environment_control`. Setup never deploys; account choices and sensitive commands require trusted host interaction, and cleanup remains limited to proven-owned setup resources.

Cooperative Stop remains available while setup holds its GitHub account lease or credentials are unavailable. Setup trims surrounding whitespace from environment names and returns the canonical target with its operation ID for subsequent status and control calls.

Input prompts refresh after setup finishes settling, and application-selection prompts include bounded, redacted choices with IDs, creation dates and the saved default. Verification reports the required setup pull request merge rather than an unexplained refusal.
