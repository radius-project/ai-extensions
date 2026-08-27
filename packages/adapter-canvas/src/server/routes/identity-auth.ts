import { remediationView } from "@radius-project/core";
import type { RemediationView } from "@radius-project/core";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

export interface SessionPromptOutcome {
  status: number;
  error?: string;
}

export interface SessionPromptMessage {
  prompt: string;
  displayPrompt: string;
}

export interface AzureCliAssistInput {
  action: "install" | "login";
  tenantId: string;
}

export interface AzureCredentialIdInput {
  tenantId: string;
  subscriptionId: string;
}

export interface AzureLoginRequiredInput {
  tenantId: string;
  activeTenantId?: string;
}

export interface AzureLoginRequiredResponse {
  error: string;
  code: string;
  tenantId: string;
  // The same guidance the prose carries, in a form the canvas can offer to run.
  // Prose is unchanged, so a client that ignores this field is unaffected.
  remediation: RemediationView;
}

// Shaped exactly like `runCommand` from `gh.ts`. Only the three fields these
// routes pass are declared, so a handler cannot quietly start using a wider
// option surface than the legacy branches did.
export type IdentityAuthRunCommand = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<string>;

// Eight narrow function seams for three routes. Nothing is moved: the CLI
// runner stays in `gh.ts`, and the prompt, GUID and Azure-message helpers in
// `server.ts`; every one of them is handed in. The module therefore spawns no
// process, touches no disk, holds no instance map, and reads no module-level
// mutable state.
export interface IdentityAuthDependencies {
  azureCredentialIdValidationError(input: AzureCredentialIdInput): string;
  azureLoginRequiredResponse(
    input: AzureLoginRequiredInput
  ): AzureLoginRequiredResponse;
  isCliCommandMissing(detail: unknown): boolean;
  isUuid(value: unknown): boolean;
  buildAzureCliAssistMessage(input: AzureCliAssistInput): SessionPromptMessage;
  // Binds the live session-prompt handler at the composition root, so this
  // module never reads the mutable module-level hook in `server.ts`.
  runSessionPrompt(
    message: SessionPromptMessage
  ): Promise<SessionPromptOutcome>;
  runCommand: IdentityAuthRunCommand;
  errorMessage(error: unknown): string;
}

const AZ_TIMEOUT = 10000;
const AWS_TIMEOUT = 15000;

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "");
}

// Verify the caller's existing Azure CLI session for a credential profile.
//
// Every failure on this route is a 200 with an `error` payload — a malformed
// body, a rejected GUID, a missing CLI, no session, and a tenant mismatch all
// answer 200. That is pre-existing and preserved: the canvas distinguishes them
// by the `code` field, not the status.
export async function handleVerifyAzureLogin(
  context: CanvasRequestContext,
  dependencies: IdentityAuthDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    const data = JSON.parse(body);
    const tenantId = (data.tenantId || "").trim();
    const subscriptionId = (data.subscriptionId || "").trim();

    // Reject non-GUID credential identifiers before using them in command
    // guidance or the az argv. The Windows process adapter quotes argv values,
    // but this remains the domain boundary and defense in depth. Empty falls
    // back to the ambient CLI context. Mirrors /api/azure-auto-setup.
    const validationError = dependencies.azureCredentialIdValidationError({
      tenantId,
      subscriptionId
    });
    if (validationError) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end(JSON.stringify({ error: validationError }));
      return;
    }

    // NOTE: we intentionally do NOT run `az login` here. Interactive
    // login opens a browser/device-code flow that blocks indefinitely
    // and would hang this server. Instead we verify the user's existing
    // Azure CLI session (and optionally switch subscription). If there
    // is no session, the canvas can ask Copilot to start device-code login.
    if (subscriptionId) {
      try {
        await dependencies.runCommand(
          "az",
          ["account", "set", "--subscription", subscriptionId],
          { timeout: AZ_TIMEOUT }
        );
      } catch (e) {}
    }

    let acct;
    try {
      const acctJson = await dependencies.runCommand(
        "az",
        ["account", "show", "-o", "json"],
        { timeout: AZ_TIMEOUT }
      );
      acct = JSON.parse(acctJson);
    } catch (e) {
      const detail = detailOf(e);
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      if (dependencies.isCliCommandMissing(detail)) {
        response.end(
          JSON.stringify({
            error: "Azure CLI is not installed.",
            code: "az-cli-missing",
            tenantId,
            remediation: remediationView("azure-cli-install", { tenantId })
          })
        );
      } else {
        response.end(
          JSON.stringify(dependencies.azureLoginRequiredResponse({ tenantId }))
        );
      }
      return;
    }

    // If a tenant was specified and the active session is for a
    // different tenant, surface a clear, actionable message.
    if (
      tenantId &&
      acct.tenantId &&
      acct.tenantId.toLowerCase() !== tenantId.toLowerCase()
    ) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end(
        JSON.stringify(
          dependencies.azureLoginRequiredResponse({
            tenantId,
            activeTenantId: acct.tenantId
          })
        )
      );
      return;
    }

    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({
        success: true,
        user: acct.user?.name || "",
        tenantId: acct.tenantId,
        subscriptionId: acct.id,
        subscriptionName: acct.name
      })
    );
  } catch (e) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({
        error: "Azure CLI verification failed: " + dependencies.errorMessage(e)
      })
    );
  }
}

// Ask the Copilot session to install Azure CLI or start a device-code login.
//
// The failure status is *dynamic*: `writeHead(promptResult.status)` answers 503
// when no session hook is registered and 502 when the session rejected. Pinning
// it to a constant would collapse two distinct client-visible outcomes, so the
// dynamic write is preserved and asserted.
export async function handleAzureCliAssist(
  context: CanvasRequestContext,
  dependencies: IdentityAuthDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    const data = JSON.parse(body || "{}");
    const action = data.action === "install" ? "install" : "login";
    const requestedTenantId =
      typeof data.tenantId === "string" ? data.tenantId.trim() : "";
    const tenantId =
      dependencies.isUuid(requestedTenantId) ? requestedTenantId : "";
    const message = dependencies.buildAzureCliAssistMessage({
      action,
      tenantId
    });
    const promptResult = await dependencies.runSessionPrompt(message);
    if (promptResult.error) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(promptResult.status);
      response.end(JSON.stringify({ error: promptResult.error }));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({
        success: true,
        message:
          action === "install" ?
            "Asked Copilot to help install Azure CLI and start Azure login. Complete the steps it opens, then click Verify Credentials again."
          : "Asked Copilot to start Azure login. Complete the sign-in flow it opens, then click Verify Credentials again."
      })
    );
  } catch (e) {
    const detail = detailOf(e);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(400);
    response.end(JSON.stringify({ error: detail || "Bad request." }));
  }
}

// Verify an AWS CLI session for a credential profile. Like the Azure
// verify, we do NOT log in interactively — we check the caller's existing
// `aws sts get-caller-identity` and (optionally) note the requested region.
//
// The inner catch swallows the underlying CLI error and answers a fixed
// message, while the outer catch reports `errorMessage(e)`; both are 200.
export async function handleVerifyAwsLogin(
  context: CanvasRequestContext,
  dependencies: IdentityAuthDependencies
): Promise<void> {
  const { response } = context;
  const body = await context.readTextBody();
  try {
    const data = JSON.parse(body || "{}");
    let ident;
    try {
      const out = await dependencies.runCommand(
        "aws",
        ["sts", "get-caller-identity", "--output", "json"],
        { timeout: AWS_TIMEOUT }
      );
      ident = JSON.parse(out);
    } catch (e) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end(
        JSON.stringify({
          error:
            'No active AWS CLI session. Run "aws configure" (or "aws sso login") in your terminal, then click Verify again.',
          remediation: remediationView("aws-cli-login", {})
        })
      );
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({
        success: true,
        accountId: ident.Account || data.accountId || "",
        arn: ident.Arn || "",
        user:
          ident.Arn ? String(ident.Arn).split("/").pop() : ident.Account || "",
        region: data.region || ""
      })
    );
  } catch (e) {
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200);
    response.end(
      JSON.stringify({
        error: "AWS CLI verification failed: " + dependencies.errorMessage(e)
      })
    );
  }
}

export function createIdentityAuthRoutes(
  dependencies: IdentityAuthDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/verify-azure-login": (context) =>
      handleVerifyAzureLogin(context, dependencies),
    "POST /api/azure-cli-assist": (context) =>
      handleAzureCliAssist(context, dependencies),
    "POST /api/verify-aws-login": (context) =>
      handleVerifyAwsLogin(context, dependencies)
  };
}
