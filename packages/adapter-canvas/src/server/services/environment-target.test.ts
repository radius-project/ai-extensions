import { describe, expect, it, vi } from "vitest";
import { createEnvironmentTargetReader } from "./environment-target.js";

const VARIABLES = [
  "api",
  "/repos/octo/shop/environments/dev%20one/variables?per_page=100",
  "--jq",
  '.variables[] | .name + "\\t" + (.value // "")'
];

describe("reading the environment a deletion targets", () => {
  it("returns the deploy role an AWS environment recorded", async () => {
    const run = vi.fn(async () =>
      [
        "AWS_ACCOUNT_ID\t123456789012",
        "AWS_ROLE_ARN\tarn:aws:iam::123456789012:role/deployer"
      ].join("\n")
    );

    expect(
      await createEnvironmentTargetReader(run)("octo/shop", "dev one")
    ).toEqual({
      provider: "aws",
      clientId: "",
      tenantId: "",
      repoId: 0,
      roleArn: "arn:aws:iam::123456789012:role/deployer"
    });
    expect(run.mock.calls).toEqual([["gh", VARIABLES, { timeout: 15000 }]]);
  });

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
      roleArn: ""
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
      roleArn: ""
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
