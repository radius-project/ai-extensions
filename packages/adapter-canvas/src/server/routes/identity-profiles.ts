import type { GitHubIdentity } from "../../gh.js";
import type {
  CredentialProfile,
  CredentialProfileInput
} from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

export interface SwitchAccountResult {
  ok: boolean;
  error?: string;
}

// Every seam is a single narrow function lifted from `server.ts`, injected
// rather than moved: `preflightRepoAdmin` and `errorMessage` stay defined there
// and are handed in, so this module owns no `gh` spawning, no disk I/O, and no
// access to the instance map. The list is wider than earlier slices only
// because five routes are in scope, not because the surface per route grew.
export interface IdentityProfilesDependencies {
  listCredentialProfiles(repo: string): CredentialProfile[];
  saveCredentialProfile(
    repo: string,
    profile: CredentialProfileInput
  ): CredentialProfile | null;
  deleteCredentialProfile(repo: string, name: string): boolean;
  getGitHubIdentity(): Promise<GitHubIdentity>;
  resetGhIdentityCache(): void;
  switchGhAccount(login: string): Promise<SwitchAccountResult>;
  setPreferredGitHubLogin(login: string): void;
  preflightRepoAdmin(repo: string): Promise<string>;
  isValidRepoSlug(value: unknown): boolean;
  errorMessage(error: unknown): string;
}

// NOTE: there is deliberately no shared `trimmed()` helper for the
// `(x || "").trim()` reads below, even though the expression repeats four
// times. Extracting it is NOT behavior-neutral: a truthy non-string field
// throws a TypeError whose message V8 builds from the *source text* of the
// failing expression, and each handler serializes that message into its
// response body via `errorMessage`. Through a helper every route answers
// `(value || "").trim is not a function`; inlined, they answer
// `(data.login || "")...`, `(data.repo || "")...` and so on, exactly as legacy
// did. The reads are also typed as `string` rather than `unknown` so no cast is
// needed, which keeps the compiled expression byte-for-byte what legacy emitted.

// List the saved credential profiles for a repo.
//
// Three pre-existing shapes are preserved verbatim. The repo is read from the
// query string, not the body. A falsy repo answers `{profiles: []}` without
// calling the store at all. And there is no try/catch: a throwing store
// propagates out of the handler rather than degrading to an empty list.
export function handleCredentialProfiles(
  context: CanvasRequestContext,
  dependencies: IdentityProfilesDependencies
): void {
  const { response } = context;
  const repo = context.url.searchParams.get("repo") || "";
  response.setHeader("Content-Type", "application/json");
  response.writeHead(200);
  response.end(
    JSON.stringify({
      profiles: repo ? dependencies.listCredentialProfiles(repo) : []
    })
  );
}

// Report the GitHub identity setup will act as, plus switchable accounts.
// Used by the Create Environment dialog to warn when the acting account
// differs from the one the host UI shows, or lacks the workflow scope.
//
// `Content-Type` is set once *before* the try, so it is present on the error
// path too — unlike `save-`/`delete-credential-profile`, which set it per
// branch. The catch answers 200, not a 5xx: a pre-existing success fallback,
// preserved because turning it into an error status would be observable
// hardening.
export async function handleGitHubIdentity(
  context: CanvasRequestContext,
  dependencies: IdentityProfilesDependencies
): Promise<void> {
  const { response } = context;
  response.setHeader("Content-Type", "application/json");
  try {
    // A re-check (?fresh=1) means the user just changed their gh auth
    // out-of-band (e.g. ran `gh auth refresh` to add write:packages). The
    // snapshot is memoized for the process, so drop it first and force `gh
    // auth status` to be re-read; otherwise we'd return the stale pre-refresh
    // scopes and the warning would never clear.
    if (context.url.searchParams.get("fresh") === "1") {
      dependencies.resetGhIdentityCache();
    }
    // Resolve identity FIRST — this primes the token strategy, so the repo
    // preflight below acts as the same account setup will. That ordering is
    // observable through the ports and must not be reversed. When the dialog
    // passes its repo, fold in the admin/read preflight so a non-admin account
    // is surfaced here, at dialog open, instead of only after submit. The
    // preflight is advisory: an invalid or missing repo silently skips it and
    // a throwing preflight is swallowed, because the identity response must
    // still render.
    const identity = await dependencies.getGitHubIdentity();
    const repoParam = (context.url.searchParams.get("repo") || "").trim();
    if (repoParam && dependencies.isValidRepoSlug(repoParam)) {
      try {
        const accessMsg = await dependencies.preflightRepoAdmin(repoParam);
        if (accessMsg) identity.repoAccess = accessMsg;
      } catch {
        /* preflight is advisory here; never fail identity on it */
      }
    }
    response.writeHead(200);
    response.end(JSON.stringify(identity));
  } catch (e) {
    response.writeHead(200);
    response.end(
      JSON.stringify({ error: dependencies.errorMessage(e), accounts: [] })
    );
  }
}

// Switch the active GitHub account setup acts as.
//
// A failed switch is a 400, not a 200 with an error payload, and so is a
// malformed body. Both differ from `github-identity` above and are preserved.
export async function handleGitHubAccount(
  context: CanvasRequestContext,
  dependencies: IdentityProfilesDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  response.setHeader("Content-Type", "application/json");
  try {
    // `body || "{}"` means an empty body yields `{}` and `login` becomes ""
    // rather than throwing, so the empty-login rejection comes from
    // `switchGhAccount`, not from the parse.
    const data = JSON.parse(body || "{}") as { login?: string };
    const login = (data.login || "").trim();
    const result = await dependencies.switchGhAccount(login);
    if (!result.ok) {
      response.writeHead(400);
      response.end(
        JSON.stringify({ error: result.error || "Failed to switch account." })
      );
      return;
    }
    // Persist the explicit choice machine-wide so it survives a restart.
    // Without this the in-memory preference dies with the process and the
    // token strategy reverts to the injected token's account — the same
    // wrong-identity failure this flow exists to prevent, deferred by one
    // process lifetime. It must happen BEFORE the identity is re-read, so the
    // returned identity reflects the new preference.
    dependencies.setPreferredGitHubLogin(login);
    response.writeHead(200);
    response.end(
      JSON.stringify({
        success: true,
        identity: await dependencies.getGitHubIdentity()
      })
    );
  } catch (e) {
    response.writeHead(400);
    response.end(JSON.stringify({ error: dependencies.errorMessage(e) }));
  }
}

// Create / update a credential profile (already verified client-side).
//
// Unlike the two GET routes, `Content-Type` is set separately inside each
// branch immediately before its `writeHead`. The set order is identical in the
// end but the placement is not, and reproducing the placement is what keeps a
// future refactor from accidentally dropping the header on one branch.
export async function handleSaveCredentialProfile(
  context: CanvasRequestContext,
  dependencies: IdentityProfilesDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    const data = JSON.parse(body || "{}") as CredentialProfileInput & {
      repo?: string;
    };
    const repo = (data.repo || "").trim();
    const name = (data.name || "").trim();
    if (!repo || !name) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end(JSON.stringify({ error: "repo and name are required." }));
      return;
    }
    // The whole parsed body is handed to the store, not just repo/name: the
    // profile fields travel in the same object.
    const saved = dependencies.saveCredentialProfile(repo, data);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ success: true, profile: saved }));
  } catch (e) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(400);
    response.end(JSON.stringify({ error: dependencies.errorMessage(e) }));
  }
}

// Delete a credential profile.
//
// Deliberately asymmetric with `save`: there is no repo/name validation here,
// so an empty body reaches the store with two empty strings and answers 200
// `{success: true, removed: false}`. Adding the missing guard would be
// observable hardening, so the asymmetry stands.
export async function handleDeleteCredentialProfile(
  context: CanvasRequestContext,
  dependencies: IdentityProfilesDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    const data = JSON.parse(body || "{}") as { repo?: string; name?: string };
    const repo = (data.repo || "").trim();
    const name = (data.name || "").trim();
    const removed = dependencies.deleteCredentialProfile(repo, name);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(JSON.stringify({ success: true, removed }));
  } catch (e) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(400);
    response.end(JSON.stringify({ error: dependencies.errorMessage(e) }));
  }
}

export function createIdentityProfilesRoutes(
  dependencies: IdentityProfilesDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/credential-profiles": (context) =>
      handleCredentialProfiles(context, dependencies),
    "GET /api/github-identity": (context) =>
      handleGitHubIdentity(context, dependencies),
    "POST /api/github-account": (context) =>
      handleGitHubAccount(context, dependencies),
    "POST /api/save-credential-profile": (context) =>
      handleSaveCredentialProfile(context, dependencies),
    "POST /api/delete-credential-profile": (context) =>
      handleDeleteCredentialProfile(context, dependencies)
  };
}
