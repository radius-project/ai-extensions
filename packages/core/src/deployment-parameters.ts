// Deployment Bicep parameter parsing, partitioning, and command policy.
//
// The deploy UI renders an optional input for every `param` declared in the
// app's Bicep file. Values the user supplies are passed to `rad deploy` as
// `--parameters name=value`; params left blank fall back to their Bicep default
// (when present) or an auto-generated value (when they have no default). This
// module is the single source of truth for both the parse and the auto-gen so
// the UI, the /api/app-params endpoint, and the provisioning step agree.

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
//
// `registryUsername` / `registryPassword` are the OCI (ghcr.io) registry
// credentials the Radius.Compute/containerImages recipe uses to push built
// images (feeding the app's `ghcr-registry-creds` Radius.Security/secrets
// resource). Their values are the GitHub Actions runner's identity —
// `github.actor` and the runner-minted `GITHUB_TOKEN` — which only exist inside
// the runner at job time, so the deploy workflow injects them. The extension
// runs on the user's machine at dispatch time and never holds the runner token,
// so it MUST NOT auto-generate values for these: a random username/password
// would be inlined into the deploy command / written into RADIUS_DEPLOY_PARAMS
// and collide with the workflow-injected `--parameters`, breaking the push.
export const WORKFLOW_MANAGED_PARAMS = new Set([
  "environment",
  "application",
  "image",
  "registryUsername",
  "registryPassword"
]);

export interface BicepParam {
  name: string;
  type: string;
  secure: boolean;
  hasDefault: boolean;
  default: string | null;
  description: string;
}

// Parse `param` declarations from Bicep source. Returns one entry per parameter:
//   { name, type, secure, hasDefault, default, description }
// Decorators (`@secure()`, `@description('…')`) that precede a `param` line are
// attributed to it; blank lines and comments between a decorator and its param
// do not break the association.
export function parseBicepParams(source: unknown): BicepParam[] {
  if (!source || typeof source !== "string") return [];
  const params: BicepParam[] = [];
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
      /^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_.\[\]?]+)/
    );
    const suffix = m ? line.slice(m[0].length).trim() : "";
    if (
      m &&
      (suffix === "" ||
        (suffix.startsWith("=") && suffix.slice(1).trim() !== ""))
    ) {
      const [, name, type] = m;
      const def = suffix === "" ? undefined : suffix.slice(1).trim();
      params.push({
        name,
        type,
        secure,
        hasDefault: def !== undefined,
        default: def !== undefined ? def.trim() : null,
        description
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
export function appParams(source: unknown): BicepParam[] {
  return parseBicepParams(source).filter(
    (p) => !WORKFLOW_MANAGED_PARAMS.has(p.name)
  );
}

// Split a resolved param map into secret and non-secret buckets using the
// `secure` flag from the parsed Bicep params. Secret values are provisioned as
// a GitHub secret (and appended by the workflow at runtime); non-secret values
// are inlined into the `rad deploy` command string the extension builds.
export function partitionParams(
  params: readonly BicepParam[],
  resolved: Readonly<Record<string, string>>
): { secret: Record<string, string>; public: Record<string, string> } {
  const secureNames = new Set(
    params.filter((p) => p.secure).map((p) => p.name)
  );
  const secret: Record<string, string> = {};
  const pub: Record<string, string> = {};
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
export function buildDeployRadCommand(
  appFile: string,
  environment: string,
  publicParams: Readonly<Record<string, string>> = {}
): string {
  const parts = ["deploy", appFile, "--environment", environment];
  for (const [name, value] of Object.entries(publicParams)) {
    parts.push("--parameters", `${name}=${value}`);
  }
  return parts.join(" ");
}

export function buildAppGraphRadCommand(appName: unknown): string {
  const safe = String(appName || "").trim();
  if (!safe || /[\s"'\\]/.test(safe)) {
    throw new Error(
      `Invalid application name for rad command: ${JSON.stringify(safe)}`
    );
  }
  return `app graph --application ${safe} --include-icons`;
}

// Build the map of application parameters to pass to `rad deploy`, given the
// app's parsed params and the (possibly partial) values the user supplied.
//   - user provided a non-empty value  -> use it
//   - blank + param has a Bicep default -> omit (Bicep applies the default)
//   - blank + param has no default      -> auto-generate a value
// Returns a plain object { name: value }.
export function resolveDeployParams(
  params: readonly BicepParam[],
  userValues: Readonly<Record<string, unknown>>,
  generateValue: (type: string) => string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    if (WORKFLOW_MANAGED_PARAMS.has(p.name)) continue;
    const raw = userValues[p.name];
    const provided = typeof raw === "string" ? raw.trim() : raw;
    if (provided !== undefined && provided !== null && provided !== "") {
      out[p.name] = String(provided);
    } else if (!p.hasDefault) {
      out[p.name] = generateValue(p.type);
    }
  }
  return out;
}
