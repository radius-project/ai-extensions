import { describe, expect, it, vi } from "vitest";
import {
  createEnvironmentProviderReader,
  createEnvironmentTargetReader
} from "./environment-target.js";

const VARIABLES = [
  "api",
  "/repos/octo/shop/environments/dev%20one/variables?per_page=100",
  "--jq",
  '.variables[] | .name + "\\t" + (.value // "")'
];

describe("reading the provider a dispatcher selects", () => {
  it.each([
    [
      "AZURE_CLIENT_ID\tclient\nAWS_ROLE_ARN\tarn:aws:iam::123456789012:role/d",
      "azure"
    ],
    ["AWS_ROLE_ARN\tarn:aws:iam::123456789012:role/deployer", "aws"],
    [
      "AZURE_CLIENT_ID\t\nAWS_ROLE_ARN\tarn:aws:iam::123456789012:role/d",
      "aws"
    ],
    ["AWS_ROLE_ARN\t", ""],
    ["OTHER\tvalue", ""]
  ])(
    "classifies %j as %j from the variables alone",
    async (variables, provider) => {
      const run = vi.fn(async () => variables);
      expect(
        await createEnvironmentProviderReader(run)("octo/shop", "dev one")
      ).toBe(provider);
      expect(run.mock.calls).toEqual([["gh", VARIABLES, { timeout: 15000 }]]);
    }
  );

  it("propagates a failed variable read", async () => {
    const run = vi.fn(async () => {
      throw new Error("HTTP 403");
    });
    await expect(
      createEnvironmentProviderReader(run)("octo/shop", "dev")
    ).rejects.toThrow("HTTP 403");
  });
});

describe("reading the environment a deletion targets", () => {
  // GitHub answers the variable read with `variables`, then the repository ID.
  const answers = (...variables: string[]) =>
    vi
      .fn()
      .mockResolvedValueOnce(variables.join("\n"))
      .mockResolvedValueOnce(" 42\n");

  it("returns the deploy role, cluster, and repository ID of an AWS environment", async () => {
    const run = answers(
      "AWS_ACCOUNT_ID\t123456789012",
      "AWS_ROLE_ARN\tarn:aws:iam::123456789012:role/deployer",
      "AWS_REGION\tus-west-2",
      "AWS_EKS_CLUSTER_NAME\tshop"
    );

    expect(
      await createEnvironmentTargetReader(run)("octo/shop", "dev one")
    ).toEqual({
      provider: "aws",
      clientId: "",
      tenantId: "",
      repoId: 42,
      roleArn: "arn:aws:iam::123456789012:role/deployer",
      trustSubjects: [],
      region: "us-west-2",
      cluster: "shop"
    });
    expect(run.mock.calls).toEqual([
      ["gh", VARIABLES, { timeout: 15000 }],
      ["gh", ["api", "/repos/octo/shop", "--jq", ".id"], { timeout: 15000 }]
    ]);
  });

  it("returns the trust subjects setup recorded", async () => {
    const subjects = [
      "repo:octo/shop:environment:dev",
      "repository_owner_id:7:repository_id:42:environment:dev"
    ];
    const run = answers(
      "AWS_ROLE_ARN\tarn:aws:iam::123456789012:role/deployer",
      `AWS_TRUST_SUBJECTS\t${JSON.stringify(subjects)}`
    );
    expect(
      (await createEnvironmentTargetReader(run)("octo/shop", "dev one"))
        .trustSubjects
    ).toEqual(subjects);
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", '"repo:octo/shop:environment:dev"'],
    ["a list with a non-string", '["repo:octo/shop:environment:dev", 7]'],
    ["a list with an empty subject", '[""]'],
    ["empty", ""]
  ])(
    "reports unreadable trust subjects, which deletion refuses, when the variable is %s",
    async (_label, value) => {
      const run = answers(
        "AWS_ROLE_ARN\tarn:aws:iam::123456789012:role/deployer",
        `AWS_TRUST_SUBJECTS\t${value}`
      );
      expect(
        (await createEnvironmentTargetReader(run)("octo/shop", "dev one"))
          .trustSubjects
      ).toBeNull();
    }
  );

  it("reads the repository ID for an Azure environment", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce("AZURE_CLIENT_ID\tclient\nAZURE_TENANT_ID\ttenant")
      .mockResolvedValueOnce(" 42\n");

    expect(
      await createEnvironmentTargetReader(run)("octo/shop", "dev one")
    ).toEqual({
      provider: "azure",
      clientId: "client",
      tenantId: "tenant",
      repoId: 42,
      roleArn: "",
      trustSubjects: [],
      region: "",
      cluster: ""
    });
    expect(run).toHaveBeenLastCalledWith(
      "gh",
      ["api", "/repos/octo/shop", "--jq", ".id"],
      { timeout: 15000 }
    );
  });

  it.each(["0", "not-a-number", ""])(
    "fails closed when GitHub returns repository ID %j",
    async (id) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce("AZURE_CLIENT_ID\tclient")
        .mockResolvedValueOnce(id);
      await expect(
        createEnvironmentTargetReader(run)("octo/shop", "dev")
      ).rejects.toThrow("GitHub returned an invalid repository id.");
    }
  );

  it("returns no provider for an environment Radius did not configure", async () => {
    const run = vi.fn(async () => "OTHER\tvalue");
    expect(
      await createEnvironmentTargetReader(run)("octo/shop", "dev")
    ).toEqual({
      provider: "",
      clientId: "",
      tenantId: "",
      repoId: 0,
      roleArn: "",
      trustSubjects: [],
      region: "",
      cluster: ""
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("propagates a failed variable read so deletion fails closed", async () => {
    const run = vi.fn(async () => {
      throw new Error("HTTP 403");
    });

    await expect(
      createEnvironmentTargetReader(run)("octo/shop", "dev")
    ).rejects.toThrow("HTTP 403");
  });
});
