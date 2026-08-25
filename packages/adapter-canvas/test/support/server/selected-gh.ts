import type {
  SelectedGhCredentialSource,
  SelectedGhExecutor
} from "../../../src/gh.js";

export function successfulSelectedGhExecutor(
  options: {
    login?: string;
    credentialSource?: SelectedGhCredentialSource;
    requiresKeyringSwitch?: boolean;
    scopes?: string[];
    run?: SelectedGhExecutor["run"];
  } = {}
): SelectedGhExecutor {
  const login = options.login || "octocat";
  const run: SelectedGhExecutor["run"] =
    options.run ||
    (async () => ({
      code: 0,
      stdout: "",
      stderr: ""
    }));
  const runOrThrow: SelectedGhExecutor["runOrThrow"] = async (
    args,
    message,
    commandOptions
  ) => {
    const result = await run(args, commandOptions);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail ? `${message}: ${detail}` : message);
    }
    return result;
  };
  return {
    login,
    credentialSource: options.credentialSource || "keyring",
    requiresKeyringSwitch:
      options.requiresKeyringSwitch ??
      (options.credentialSource || "keyring") === "keyring",
    scopes: options.scopes || ["repo", "workflow", "write:packages"],
    run,
    runOrThrow,
    verifyIdentity: async () => {},
    packageCredentials: () => ({
      username: login,
      token: "synthetic-package-credential",
      source: "keyring"
    }),
    redact: (value) => value,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
}
