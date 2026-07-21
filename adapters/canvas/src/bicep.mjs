// Canvas adapter — Bicep parameter parsing + value auto-generation.
//
// The deploy UI renders an optional input for every `param` declared in the
// app's Bicep file. Values the user supplies are passed to `rad deploy` as
// `--parameters name=value`; params left blank fall back to their Bicep default
// (when present) or an auto-generated value (when they have no default). This
// module is the single source of truth for both the parse and the auto-gen so
// the UI, the /api/app-params endpoint, and the provisioning step agree.

import { randomBytes } from "node:crypto";

// Parameters supplied outside the app-parameter provisioning path; never surface
// these in the UI, auto-generate values for them, or inline them into the
// `rad deploy` command. `environment` and `application` are injected by the rad
// CLI at deploy time (the CLI resolves them from the workspace/environment
// context, per Radius' automatic parameter injection), and `image` is supplied
// by the deploy workflow. Auto-generating a random `application` value here would
// both corrupt the application name and make `rad deploy` reject the deployment
// when the template does not declare an `application` parameter
// ("The following parameters were supplied, but do not correspond to any
// parameters defined in the template: 'application'").
export const WORKFLOW_MANAGED_PARAMS = new Set(["environment", "application", "image"]);

// Parse `param` declarations from Bicep source. Returns one entry per parameter:
//   { name, type, secure, hasDefault, default, description }
// Decorators (`@secure()`, `@description('…')`) that precede a `param` line are
// attributed to it; blank lines and comments between a decorator and its param
// do not break the association.
export function parseBicepParams(source) {
  if (!source || typeof source !== "string") return [];
  const params = [];
  let secure = false;
  let description = "";
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("@secure")) {
      secure = true;
      continue;
    }
    const desc = line.match(/^@description\(\s*'([\s\S]*?)'\s*\)/);
    if (desc) {
      description = desc[1];
      continue;
    }
    if (line.startsWith("@")) continue; // other decorators: keep pending state
    const m = line.match(
      /^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_.\[\]?]+)\s*(?:=\s*([\s\S]+))?$/,
    );
    if (m) {
      const [, name, type, def] = m;
      params.push({
        name,
        type,
        secure,
        hasDefault: def !== undefined,
        default: def !== undefined ? def.trim() : null,
        description,
      });
      secure = false;
      description = "";
      continue;
    }
    // Any other statement (resource, var, output, …) resets pending decorators.
    secure = false;
    description = "";
  }
  return params;
}

// The subset of parsed params the UI/provisioning cares about: everything the
// workflow does not manage itself.
export function appParams(source) {
  return parseBicepParams(source).filter(
    (p) => !WORKFLOW_MANAGED_PARAMS.has(p.name),
  );
}

// Generate a value for a param that has no Bicep default and was left blank by
// the user. Typed so `int`/`bool` produce valid literals; everything else gets
// a URL-safe random secret (suitable for passwords, keys, etc.).
export function autogenValue(type) {
  const t = String(type || "").toLowerCase();
  if (t === "int") return String(Math.floor(Math.random() * 1e6));
  if (t === "bool") return "false";
  return randomBytes(18).toString("base64url");
}

// Split a resolved param map into secret and non-secret buckets using the
// `secure` flag from the parsed Bicep params. Secret values are provisioned as
// a GitHub secret (and appended by the workflow at runtime); non-secret values
// are inlined into the `rad deploy` command string the extension builds.
export function partitionParams(params, resolved) {
  const secureNames = new Set(
    params.filter((p) => p.secure).map((p) => p.name),
  );
  const secret = {};
  const pub = {};
  for (const [name, value] of Object.entries(resolved)) {
    if (secureNames.has(name)) secret[name] = value;
    else pub[name] = value;
  }
  return { secret, public: pub };
}

// Build the `rad deploy` command the workflow runs via its `rad_commands`
// input. Only NON-secret params are inlined here (word-split-safe for simple
// values); secret params are appended by the workflow from the secret JSON so
// their values never land in the dispatch input or the recorded artifact.
export function buildDeployRadCommand(appFile, environment, publicParams = {}) {
  const parts = ["deploy", appFile, "--environment", environment];
  for (const [name, value] of Object.entries(publicParams)) {
    parts.push("--parameters", `${name}=${value}`);
  }
  return parts.join(" ");
}

export function buildAppGraphRadCommand(appName) {
  const safe = String(appName || "").trim();
  if (!safe || /[\s"'\\]/.test(safe)) {
    throw new Error(`Invalid application name for rad command: ${JSON.stringify(safe)}`);
  }
  return `app graph --application ${safe} --preview --include-icons`;
}

// Extract the Radius application name from an app.bicep source. The name is
// declared as `name: '<app>'` on the single `Radius.Core/applications` resource
// (e.g. `resource app 'Radius.Core/applications@2025-08-01-preview' = { name:
// 'my-app' ... }`). Prefer that resource's name; fall back to the first
// `name: '...'` in the file, mirroring the deploy workflow's own extraction
// (`grep -oP "name:\s*'\K[^']+" .radius/app.bicep | head -1`). Returns "" when
// no name can be found.
export function extractAppName(source) {
  if (!source) return "";
  const onResource = source.match(
    /applications@[^'"]*['"]\s*=\s*\{[\s\S]*?\bname:\s*['"]([^'"]+)['"]/
  );
  if (onResource) return onResource[1];
  const first = source.match(/\bname:\s*['"]([^'"]+)['"]/);
  return first ? first[1] : "";
}

// Build the map of application parameters to pass to `rad deploy`, given the
// app's parsed params and the (possibly partial) values the user supplied.
//   - user provided a non-empty value  -> use it
//   - blank + param has a Bicep default -> omit (Bicep applies the default)
//   - blank + param has no default      -> auto-generate a value
// Returns a plain object { name: value }.
export function resolveDeployParams(params, userValues = {}) {
  const out = {};
  for (const p of params) {
    if (WORKFLOW_MANAGED_PARAMS.has(p.name)) continue;
    const raw = userValues[p.name];
    const provided = typeof raw === "string" ? raw.trim() : raw;
    if (provided !== undefined && provided !== null && provided !== "") {
      out[p.name] = String(provided);
    } else if (!p.hasDefault) {
      out[p.name] = autogenValue(p.type);
    }
  }
  return out;
}
