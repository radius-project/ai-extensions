import { isAzResourceNotFound } from "./platforms/setup-azure-identity.js";
import {
  azureRetryDelayMs,
  isRetryableAzureReadFailure,
  isReplicationLagError
} from "./setup-azure-reads.js";
import type {
  AzureRecoveryPort,
  ProviderMutationCommandResult
} from "./setup-azure-recovery.js";
export async function ensureAzureServicePrincipal(
  clientId: string,
  runAz: (args: string[]) => Promise<Partial<ProviderMutationCommandResult>>,
  recovery: AzureRecoveryPort | undefined,
  beforeCreate: () => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void>
): Promise<
  | {
      ok: true;
      state: "created" | "reused" | "created_candidate";
      origin: "unknown" | "pre_existing" | "this_operation";
      objectId: string | null;
    }
  | { ok: false; stopped: true }
  | { ok: false; stopped?: false; stderr: string }
> {
  const showArgs = [
    "ad",
    "sp",
    "show",
    "--id",
    clientId,
    "--query",
    "id",
    "-o",
    "tsv"
  ];
  const readObjectId = async (): Promise<{
    ok: boolean;
    objectId: string;
    stderr: string;
  }> => {
    recovery?.assertActive();
    const result = await runAz(showArgs);
    const read = {
      ok:
        result.timedOut !== true && (result.code === 0 || result.code === "0"),
      objectId: String(result.stdout || "").trim(),
      stderr:
        result.timedOut === true ?
          `ETIMEDOUT: Service Principal lookup timed out. ${String(result.stderr || "").trim()}`.trim()
        : String(result.stderr || "").trim()
    };
    if (!read.ok || !read.objectId) recovery?.assertActive();
    return read;
  };
  const pendingCreate =
    recovery ? recovery.find("azure_service_principal.create", clientId) : null;
  const before = await readObjectId();
  if (before.ok && before.objectId) {
    // A principal that is here now is not automatically one that was here
    // before. This operation may have created it and crashed before the ledger
    // caught up, and reading that as pre-existing would leave a principal
    // Radius made behind at rollback. The journal is asked first.
    if (!pendingCreate) {
      return {
        ok: true,
        state: "reused",
        origin: "pre_existing",
        objectId: before.objectId
      };
    }
    if (pendingCreate.status === "manual_required") {
      return {
        ok: false,
        stderr:
          pendingCreate.evidence ||
          `Radius cannot prove who created the Service Principal for application ${clientId}.`
      };
    }
    if (pendingCreate.status === "not_applied") {
      // Entra refused this operation's create, so what answers now predates it.
      return {
        ok: true,
        state: "reused",
        origin: "pre_existing",
        objectId: before.objectId
      };
    }
    if (pendingCreate.status === "confirmed") {
      const recorded = pendingCreate.providerId || null;
      if (recorded && recorded === before.objectId) {
        // Entra acknowledged the create and recorded this exact object id, so
        // the rollback owns it even though the crash beat the ledger.
        return {
          ok: true,
          state: "created",
          origin: "this_operation",
          objectId: before.objectId
        };
      }
      // Either the confirmation predates object ids being recorded, or the
      // principal under this application is a different object than the one
      // this operation made. Neither proves ownership, so nothing is claimed
      // and nothing will be deleted.
      return {
        ok: true,
        state: "created_candidate",
        origin: "unknown",
        objectId: before.objectId
      };
    }
    // A prepared or outcome-unknown create is settled through the journal below.
    // Its provider read records the exact object id before any later write runs.
  }
  if (before.ok && !before.objectId) {
    return {
      ok: false,
      stderr: "The Service Principal lookup returned an empty object id."
    };
  }
  if (!before.ok && !isAzResourceNotFound(before.stderr)) {
    return {
      ok: false,
      stderr:
        before.stderr ||
        "Failed to look up the Service Principal before creation."
    };
  }

  const createArgs = ["ad", "sp", "create", "--id", clientId];
  const createdObjectId = (
    result: Partial<ProviderMutationCommandResult>
  ): string | null => {
    try {
      const body = JSON.parse(String(result.stdout || "")) as {
        id?: unknown;
      };
      if (typeof body?.id === "number" && Number.isFinite(body.id)) {
        return String(body.id);
      }
      return typeof body?.id === "string" && body.id.trim() ?
          body.id.trim()
        : null;
    } catch {
      return null;
    }
  };
  const runCreate = async (): Promise<ProviderMutationCommandResult> => {
    const result = await runAz(createArgs);
    return {
      code: result.code ?? 1,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      ...(result.timedOut === true ? { timedOut: true } : {})
    };
  };
  const reconcilePrincipal = async () => {
    for (let attempt = 0; ; attempt++) {
      const after = await readObjectId();
      if (after.ok && after.objectId) {
        return {
          state: "applied" as const,
          value: after.objectId,
          evidence:
            "The Service Principal for this operation's exact application client id exists after the interrupted create.",
          providerId: after.objectId
        };
      }
      if (after.ok) {
        throw new Error(
          "The Service Principal lookup returned an empty object id."
        );
      }
      const retryable =
        isAzResourceNotFound(after.stderr) ||
        isRetryableAzureReadFailure(after.stderr);
      const delay = azureRetryDelayMs(after.stderr, 2000 * (attempt + 1));
      if (!retryable || attempt >= 5 || delay === null) {
        throw new Error(
          after.stderr || "The Service Principal state could not be read."
        );
      }
      await sleep(delay);
    }
  };
  const mutationKind = "azure_service_principal.create";
  if (
    (!recovery || recovery.willWrite(mutationKind, clientId)) &&
    !(await beforeCreate())
  ) {
    return { ok: false, stopped: true };
  }
  if (!recovery) {
    const create = await runCreate();
    if (create.code === 0 || create.code === "0") {
      return {
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: createdObjectId(create)
      };
    }
    const after = await readObjectId();
    if (after.ok && after.objectId) {
      // Absent before this attempt, present after its own create attempt: this
      // reconciles a failed create against reality, and it is not a reuse.
      return {
        ok: true,
        state: "created_candidate",
        origin: "unknown",
        objectId: after.objectId
      };
    }
    return {
      ok: false,
      stderr:
        create.stderr ||
        after.stderr ||
        "Could not create or find the Service Principal."
    };
  }

  for (let attempt = 0; ; attempt++) {
    const recovered = await recovery.execute<string>({
      kind: mutationKind,
      target: clientId,
      providerIdempotencyKey: clientId,
      beforeMutation: beforeCreate,
      mutate: runCreate,
      accept: (result) => createdObjectId(result) || "",
      // Settled with the confirmed status, so a crash between Entra's answer and
      // the ledger still leaves a restart able to tell this principal from one
      // that was already there.
      providerIdOf: (result) => createdObjectId(result),
      // A not-found read can lag behind a successful write. It never proves that
      // an interrupted create was rejected or permits a second create.
      reconcile: reconcilePrincipal
    });
    if (recovered.state === "cancelled") {
      return { ok: false, stopped: true };
    }
    if (recovered.state === "not_applied") {
      const rejected = recovered.result;
      const firstOutput = (
        value:
          | {
              stderr?: string;
              stdout?: string;
            }
          | undefined
      ) =>
        [value?.stderr, value?.stdout]
          .map((text) => (text || "").trim())
          .find(Boolean) || "";
      const detail = firstOutput(rejected);
      const permissionFailure =
        /HTTP\s*(?:401|403)|Authorization|Authentication|Insufficient privileges/i.test(
          detail
        );
      const retryable =
        rejected &&
        !permissionFailure &&
        (isReplicationLagError(detail) || isRetryableAzureReadFailure(detail));
      const delay = azureRetryDelayMs(detail, 2000 * (attempt + 1));
      if (retryable && attempt < 5 && delay !== null) {
        if (!(await beforeCreate())) return { ok: false, stopped: true };
        await sleep(delay);
        if (!(await beforeCreate())) return { ok: false, stopped: true };
        continue;
      }
      return {
        ok: false,
        stderr:
          detail ||
          recovered.diagnostic ||
          "Could not create or find the Service Principal."
      };
    }
    return recovered.recovered ?
        {
          ok: true,
          state: "created_candidate",
          origin: "unknown",
          objectId: recovered.value
        }
      : {
          ok: true,
          state: "created",
          origin: "this_operation",
          objectId: recovered.value || null
        };
  }
}
