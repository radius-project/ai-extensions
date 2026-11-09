import type { GitHubJsonResponse } from "../../../src/azure-oidc.js";

// A stateful stand-in for the GitHub reads and writes AWS setup, rollback,
// delete, and Repair make: the repository, its OIDC subject customization, and
// its environments with their variables. Reads answer from state, and writes
// change it, so a stopped run can be compared with what it saved.

export interface FakeGitHubEnvironment {
  name: string;
  id: number;
  variables: Map<string, string>;
}

export interface FakeGitHubCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const NOT_FOUND: FakeGitHubCommandResult = {
  code: 1,
  stdout: "",
  stderr: "gh: Not Found (HTTP 404)"
};

function json(value: unknown): FakeGitHubCommandResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

// The `--jq` filters Radius passes to `gh api`, applied the way gh does.
function jq(
  filter: string,
  answer: FakeGitHubCommandResult
): FakeGitHubCommandResult {
  const body: {
    environments?: Array<{ name: string }>;
    variables?: Array<{ name: string; value: string }>;
  } = JSON.parse(answer.stdout);
  if (filter === ".environments[].name") {
    return {
      ...answer,
      stdout: (body.environments ?? []).map(({ name }) => `${name}\n`).join("")
    };
  }
  if (filter === '.variables[] | .name + "\\t" + (.value // "")') {
    return {
      ...answer,
      stdout: (body.variables ?? [])
        .map(({ name, value }) => `${name}\t${value}\n`)
        .join("")
    };
  }
  throw new Error(`fake github: no answer for --jq ${filter}`);
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

export class FakeGitHub {
  readonly repo: string;
  readonly repoId: number;
  readonly ownerId: number;
  readonly environments = new Map<string, FakeGitHubEnvironment>();
  // GitHub's answer for the repository's OIDC subject customization.
  oidcCustomization: Record<string, unknown> = {
    use_default: true,
    use_immutable_subject: false
  };
  private nextEnvironmentId = 17;

  constructor(
    repo = "octo/shop",
    repoId = 42,
    ownerId = 7,
    readonly login = "saved-account"
  ) {
    this.repo = repo;
    this.repoId = repoId;
    this.ownerId = ownerId;
  }

  addEnvironment(
    name: string,
    variables: Record<string, string> = {}
  ): FakeGitHubEnvironment {
    const environment = {
      name,
      id: this.nextEnvironmentId++,
      variables: new Map(Object.entries(variables))
    };
    this.environments.set(name.toLowerCase(), environment);
    return environment;
  }

  environment(name: string): FakeGitHubEnvironment | undefined {
    return this.environments.get(name.toLowerCase());
  }

  snapshot(): Record<string, Record<string, string>> {
    return Object.fromEntries(
      [...this.environments.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((environment) => [
          environment.name,
          Object.fromEntries([...environment.variables].sort())
        ])
    );
  }

  /** The REST read `runGitHubJson` makes, by API path. */
  readJson(apiPath: string): GitHubJsonResponse {
    const answer = this.api(apiPath);
    if (answer.code !== 0) {
      return { ok: false, status: 404, json: null, stderr: answer.stderr };
    }
    const parsed: unknown = JSON.parse(answer.stdout);
    return {
      ok: true,
      status: 200,
      json:
        typeof parsed === "object" && parsed !== null ?
          Object.fromEntries(Object.entries(parsed))
        : null,
      stderr: ""
    };
  }

  /** One `gh <args>` call through a selected account. */
  gh(args: readonly string[]): FakeGitHubCommandResult {
    if (args[0] === "variable" && (args[1] === "set" || args[1] === "delete")) {
      const environment = this.environment(flag(args, "--env"));
      if (!environment || flag(args, "--repo") !== this.repo) return NOT_FOUND;
      const name = args[2] ?? "";
      if (args[1] === "delete") {
        return environment.variables.delete(name) ?
            { code: 0, stdout: "", stderr: "" }
          : NOT_FOUND;
      }
      environment.variables.set(name, flag(args, "--body"));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] !== "api") {
      throw new Error(`fake github: no answer for gh ${args.join(" ")}`);
    }
    const method = flag(args, "--method") || flag(args, "-X") || "GET";
    // The path is the first argument that is not a flag or a flag's value.
    const apiPath =
      args.slice(1).find((arg, index, rest) => {
        const previous = index > 0 ? rest[index - 1] : "";
        return (
          !arg.startsWith("-") &&
          !["--method", "-X", "--jq", "-H"].includes(previous ?? "")
        );
      }) ?? "";
    if (method === "DELETE")
      return this.delete(`/${apiPath.replace(/^\//, "")}`);
    if (method !== "GET") {
      throw new Error(`fake github: no answer for gh ${args.join(" ")}`);
    }
    if (apiPath === "user") return json({ login: this.login });
    const answer = this.api(apiPath);
    const filter = flag(args, "--jq");
    return filter && answer.code === 0 ? jq(filter, answer) : answer;
  }

  /** Whether a `gh <args>` call changes GitHub. */
  static isWrite(args: readonly string[]): boolean {
    if (args[0] === "variable") return args[1] !== "get" && args[1] !== "list";
    const method = flag(args, "--method") || flag(args, "-X") || "GET";
    return method !== "GET";
  }

  /** Delete an environment, as the idempotent delete port does. */
  deleteEnvironment(name: string): "deleted" | "not_found" {
    return this.environments.delete(name.toLowerCase()) ?
        "deleted"
      : "not_found";
  }

  private api(apiPath: string): FakeGitHubCommandResult {
    const [path = ""] = apiPath.replace(/^\//, "").split("?");
    const base = `repos/${this.repo}`;
    if (path === base) {
      return json({
        full_name: this.repo,
        id: this.repoId,
        owner: { id: this.ownerId },
        permissions: { admin: true }
      });
    }
    if (path === `${base}/actions/oidc/customization/sub`) {
      return json(this.oidcCustomization);
    }
    const environmentPath = new RegExp(
      `^${base.replace("/", "\\/")}\\/environments(?:\\/([^/]+)(?:\\/variables(?:\\/([^/]+))?)?)?$`
    ).exec(path);
    if (!environmentPath) {
      throw new Error(`fake github: no answer for GET ${apiPath}`);
    }
    const [, encodedName, encodedVariable] = environmentPath;
    if (encodedName === undefined) {
      return json({
        total_count: this.environments.size,
        environments: [...this.environments.values()].map(({ name, id }) => ({
          name,
          id
        }))
      });
    }
    const environment = this.environment(decodeURIComponent(encodedName));
    if (!environment) return NOT_FOUND;
    if (!path.includes("/variables")) {
      return json({ name: environment.name, id: environment.id });
    }
    if (encodedVariable === undefined) {
      return json({
        total_count: environment.variables.size,
        variables: [...environment.variables].map(([name, value]) => ({
          name,
          value
        }))
      });
    }
    const name = decodeURIComponent(encodedVariable);
    const value = environment.variables.get(name);
    return value === undefined ? NOT_FOUND : json({ name, value });
  }

  private delete(apiPath: string): FakeGitHubCommandResult {
    const match = new RegExp(
      `^/repos/${this.repo.replace("/", "\\/")}/environments/([^/]+)(?:/variables/([^/]+))?$`
    ).exec(apiPath);
    if (!match) throw new Error(`fake github: no answer for DELETE ${apiPath}`);
    const environment = this.environment(decodeURIComponent(match[1] ?? ""));
    if (!environment) return NOT_FOUND;
    if (match[2] === undefined) {
      this.environments.delete(environment.name.toLowerCase());
      return { code: 0, stdout: "", stderr: "" };
    }
    return environment.variables.delete(decodeURIComponent(match[2])) ?
        { code: 0, stdout: "", stderr: "" }
      : NOT_FOUND;
  }
}
