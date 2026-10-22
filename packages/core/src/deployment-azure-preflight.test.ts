import { describe, expect, it, vi } from "vitest";
import {
  validateDeploymentAzureIdentity,
  type DeploymentAzurePorts
} from "./deployment-azure-preflight.js";
import type { GitHubJsonResponse } from "./platforms/setup-azure-identity.js";

const repo = "acme/widgets";
const environment = "production";
const subjects = [
  "repo:acme/widgets:environment:production",
  "repo:acme@101/widgets@202:environment:production"
];
const absent: GitHubJsonResponse = { ok: false, status: 404 };

function fixture(
  options: {
    variable?: GitHubJsonResponse;
    repositoryVariable?: GitHubJsonResponse;
    canonical?: GitHubJsonResponse;
    customization?: GitHubJsonResponse;
    readSubjects?: DeploymentAzurePorts["readSubjects"];
    failAt?: "variable" | "oidc";
  } = {}
) {
  const paths: string[] = [];
  const readSubjects = vi.fn(
    options.readSubjects ??
      (async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([...subjects, null, " "])
      }))
  );
  const ports: DeploymentAzurePorts = {
    readSubjects,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    readGitHub: async (path) => {
      paths.push(path);
      if (
        path ===
        `/repos/${repo}/environments/${environment}/variables/AZURE_CLIENT_ID`
      ) {
        if (options.failAt === "variable")
          throw new Error("variable unavailable");
        return options.variable ?? { ok: true, json: { value: " client-id " } };
      }
      if (path === `/repos/${repo}/actions/variables/AZURE_CLIENT_ID`)
        return options.repositoryVariable ?? absent;
      if (path === `/repos/${repo}/environments/${environment}`)
        return options.canonical ?? { ok: true, json: { name: environment } };
      if (options.failAt === "oidc") throw new Error("oidc unavailable");
      if (path === `/repos/${repo}`)
        return {
          ok: true,
          json: { full_name: repo, id: 202, owner: { id: 101 } }
        };
      if (path === `/repos/${repo}/actions/oidc/customization/sub`)
        return options.customization ?? absent;
      throw new Error(`Unscripted GitHub read: ${path}`);
    }
  };
  return { ports, paths, readSubjects };
}

describe("deployment Azure identity preflight", () => {
  it("covers both possible subjects and ignores flexible/blank entries", async () => {
    const { ports, readSubjects } = fixture();
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toEqual({ status: "covered" });
    expect(readSubjects).toHaveBeenCalledExactlyOnceWith("client-id");
  });

  it("uses a repository variable only after a missing environment variable", async () => {
    const { ports, paths, readSubjects } = fixture({
      variable: absent,
      repositoryVariable: { ok: true, json: { value: "repository-client" } }
    });
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toEqual({ status: "covered" });
    expect(paths.slice(0, 2)).toEqual([
      `/repos/${repo}/environments/${environment}/variables/AZURE_CLIENT_ID`,
      `/repos/${repo}/actions/variables/AZURE_CLIENT_ID`
    ]);
    expect(readSubjects).toHaveBeenCalledExactlyOnceWith("repository-client");
  });

  it("skips intentionally disabled login without consulting a repository fallback", async () => {
    const { ports, paths, readSubjects } = fixture({
      variable: { ok: true, json: { value: " \n " } }
    });
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toMatchObject({
      status: "skipped",
      message: expect.stringContaining("AZURE_CLIENT_ID is empty")
    });
    expect(paths).toHaveLength(1);
    expect(readSubjects).not.toHaveBeenCalled();
  });

  it("warns when neither scope defines a client", async () => {
    const { ports } = fixture({ variable: absent });
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toMatchObject({
      status: "unverified",
      message: expect.stringContaining("neither GitHub environment")
    });
  });

  const unreadable: GitHubJsonResponse[] = [
    { ok: false },
    { ok: false, status: 403 },
    { ok: false, status: 403, stderr: "forbidden" },
    { ok: true },
    { ok: true, json: {} },
    { ok: true, json: { value: 3, name: 3 } }
  ];
  it.each(unreadable)(
    "warns on an unreadable variable without an implicit repository fallback: %j",
    async (variable) => {
      const { ports, paths, readSubjects } = fixture({ variable });
      expect(
        await validateDeploymentAzureIdentity(repo, environment, ports)
      ).toMatchObject({
        status: "unverified",
        message: expect.stringContaining("AZURE_CLIENT_ID")
      });
      expect(paths).toHaveLength(1);
      expect(readSubjects).not.toHaveBeenCalled();
    }
  );

  it.each([...unreadable, { ok: true, json: { name: " " } }])(
    "warns when canonical environment identity is unavailable: %j",
    async (canonical) => {
      const { ports, readSubjects } = fixture({ canonical });
      expect(
        await validateDeploymentAzureIdentity(repo, environment, ports)
      ).toMatchObject({
        status: "unverified",
        message: expect.stringContaining('environment "production"')
      });
      expect(readSubjects).not.toHaveBeenCalled();
    }
  );

  it.each(["variable", "oidc"] as const)(
    "retains thrown %s read failures as explicit warnings",
    async (failAt) => {
      const { ports } = fixture({ failAt });
      expect(
        await validateDeploymentAzureIdentity(repo, environment, ports)
      ).toMatchObject({
        status: "unverified",
        message: expect.stringContaining(`${failAt} unavailable`)
      });
    }
  );

  it("uses canonical environment casing for both possible subjects", async () => {
    const { ports } = fixture({
      canonical: { ok: true, json: { name: " Production " } },
      customization: {
        ok: true,
        json: { use_default: true, use_immutable_subject: false }
      },
      readSubjects: async () => ({
        code: 0,
        stdout: JSON.stringify(
          subjects.map((subject) => subject.replace("production", "Production"))
        ),
        stderr: ""
      })
    });
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toEqual({ status: "covered" });
  });

  it.each([
    { code: 1, stdout: "", stderr: "Azure unavailable" },
    { code: "ENOENT", stdout: "", stderr: "" },
    { code: 0, stdout: "not json", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "null", stderr: "" },
    { code: 0, stdout: "{}", stderr: "" }
  ])(
    "preserves warning-only policy when local Azure reads cannot establish coverage: %j",
    async (result) => {
      const { ports } = fixture({ readSubjects: async () => result });
      expect(
        await validateDeploymentAzureIdentity(repo, environment, ports)
      ).toMatchObject({
        status: "unverified",
        message: expect.stringContaining("Deploying anyway")
      });
    }
  );

  it("warns on a thrown local Azure read", async () => {
    const { ports } = fixture({
      readSubjects: async () => {
        throw new Error("local Azure unavailable");
      }
    });
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toMatchObject({
      status: "unverified",
      message: expect.stringContaining("local Azure unavailable")
    });
  });

  it("does not infer a definitive failure from partial mutable/immutable coverage", async () => {
    const { ports } = fixture({
      readSubjects: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([subjects[0]])
      })
    });
    expect(
      await validateDeploymentAzureIdentity(repo, environment, ports)
    ).toMatchObject({
      status: "unverified",
      message: expect.stringContaining(`no credential for "${subjects[1]}"`)
    });
  });

  it("reports every case mismatch with corrective rather than recreate guidance", async () => {
    const { ports } = fixture({
      readSubjects: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          "unrelated",
          ...subjects.map((value) => value.toUpperCase())
        ])
      })
    });
    const result = await validateDeploymentAzureIdentity(
      repo,
      environment,
      ports
    );
    expect(result).toMatchObject({ status: "case-mismatch" });
    if (result.status === "covered") throw new Error("Expected mismatch");
    for (const subject of subjects) {
      expect(result.message).toContain(`expected "${subject}"`);
      expect(result.message).toContain(subject.toUpperCase());
    }
    expect(result.message).toContain(
      "Correct the existing credentials rather than re-running"
    );
    expect(result.message).toContain("No workflow run was started");
  });

  it.each([0, 1, 3, 4])(
    "reports missing coverage with at most three near matches (%i supplied)",
    async (count) => {
      const names = Array.from(
        { length: count },
        (_, index) => `unrelated-${index}`
      );
      const { ports } = fixture({
        readSubjects: async () => ({
          code: 0,
          stderr: "",
          stdout: JSON.stringify(names)
        })
      });
      const result = await validateDeploymentAzureIdentity(
        repo,
        environment,
        ports
      );
      expect(result).toMatchObject({ status: "missing" });
      if (result.status === "covered")
        throw new Error("Expected missing coverage");
      expect(result.message).toContain(
        "no federated credential matching any subject"
      );
      expect(result.message.includes("Existing credential subjects")).toBe(
        count > 0
      );
      expect(result.message.includes("...")).toBe(count > 3);
      expect(result.message).not.toContain("unrelated-3");
    }
  );
});
