import { redactCredentials } from "./credential-redaction.js";

export interface DeploymentSecretTarget {
  readonly repo: string;
  readonly environment: string;
}

export interface DeploymentSecretPorts {
  isCurrent(): boolean;
  readNames(target: DeploymentSecretTarget): Promise<readonly string[]>;
  write(
    target: DeploymentSecretTarget,
    parameters: Readonly<Record<string, string>>
  ): Promise<void>;
  errorMessage(error: unknown): string;
  log(message: string): void;
}

export type DeploymentSecretOutcome =
  | { readonly kind: "ready"; readonly provisioned: boolean }
  | { readonly kind: "refused" | "cancelled"; readonly message: string };

export async function ensureDeploymentSecret(
  target: DeploymentSecretTarget,
  parameters: Readonly<Record<string, string>>,
  ports: DeploymentSecretPorts
): Promise<DeploymentSecretOutcome> {
  const selected = { ...target };
  const values = { ...parameters };
  const names = Object.keys(values).join(", ");
  const cancelled = (): DeploymentSecretOutcome => ({
    kind: "cancelled",
    message: "Deployment preparation stopped; no workflow was dispatched."
  });
  if (!ports.isCurrent()) return cancelled();
  if (!selected.repo.trim() || !selected.environment.trim()) {
    return {
      kind: "refused",
      message: "A repository and environment are required."
    };
  }
  if (!names) return { kind: "ready", provisioned: false };

  let phase = "read";
  try {
    const existing = await ports.readNames(selected);
    if (!ports.isCurrent()) return cancelled();
    if (existing.includes("RADIUS_DEPLOY_PARAMS")) {
      return { kind: "ready", provisioned: false };
    }
    ports.log(
      `Provisioning RADIUS_DEPLOY_PARAMS for "${selected.environment}" (${names})...`
    );
    if (!ports.isCurrent()) return cancelled();
    phase = "write";
    await ports.write(selected, values);
    if (!ports.isCurrent()) return cancelled();
    phase = "verify";
    const written = await ports.readNames(selected);
    if (!ports.isCurrent()) return cancelled();
    if (!written.includes("RADIUS_DEPLOY_PARAMS")) {
      return {
        kind: "refused",
        message:
          `RADIUS_DEPLOY_PARAMS was accepted but is not present on environment "${selected.environment}". ` +
          `The deploy would fail for a missing required parameter (${names}), so it was not started.`
      };
    }
    ports.log(`RADIUS_DEPLOY_PARAMS is set on "${selected.environment}".`);
    return { kind: "ready", provisioned: true };
  } catch (error) {
    if (!ports.isCurrent()) return cancelled();
    // These values are known secrets, including short or JSON-escaped values.
    // Replace them before the generic credential scrubber and diagnostic cap.
    const secrets = Object.values(values)
      .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    const escaped = secrets.map((value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    const diagnostic = ports.errorMessage(error);
    const redacted =
      escaped.length ?
        diagnostic.replace(new RegExp(escaped.join("|"), "g"), "[REDACTED]")
      : diagnostic;
    const action =
      phase === "write" ? "provision"
      : phase === "read" ? "read"
      : "verify";
    return {
      kind: "refused",
      message:
        `Could not ${action} RADIUS_DEPLOY_PARAMS on environment "${selected.environment}": ` +
        redactCredentials(redacted).slice(0, 4000) +
        `. The deploy would fail for a missing required parameter (${names}), so it was not started.`
    };
  }
}
