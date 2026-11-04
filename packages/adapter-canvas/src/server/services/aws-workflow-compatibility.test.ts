import { describe, expect, it } from "vitest";
import { requireCurrentAwsWorkflows } from "./aws-workflow-compatibility.js";

const file = "run-rad-commands-aws.yml";
const input = { provider: "aws", files: [file], workingBranch: "feature" };
function harness(content: string | null = "current") {
  const reads: string[] = [];
  return {
    reads,
    ports: {
      environmentProvider: async () => "aws",
      defaultBranch: async () => "main",
      templates: async () => ({ [file]: "current" }),
      readFile: async (path: string, branch: string) => {
        reads.push(`${branch}:${path}`);
        return content;
      },
      errorMessage: (error: unknown) => String(error)
    }
  };
}
describe("AWS workflow compatibility", () => {
  it("verifies the committed AWS provider on both dispatch branches", async () => {
    const h = harness();
    await requireCurrentAwsWorkflows(input, h.ports);
    expect(h.reads).toEqual([
      `main:.github/workflows/${file}`,
      `feature:.github/workflows/${file}`
    ]);
  });
  it.each(["legacy create-access-entry", null])(
    "refuses a failed or silently skipped template sync",
    async (content) => {
      await expect(
        requireCurrentAwsWorkflows(input, harness(content).ports)
      ).rejects.toThrow("pull request if the branch is protected");
    }
  );
  it("does not alter Azure dispatch when its unused AWS provider is stale", async () => {
    const h = harness("old AWS workflow");
    await requireCurrentAwsWorkflows(
      { ...input, provider: "aws" },
      {
        ...h.ports,
        environmentProvider: async () => "azure"
      }
    );
    expect(h.reads).toEqual([]);
  });
  it.each(["", "azure", "aws"])(
    "uses saved AWS configuration instead of provider hint %j",
    async (provider) => {
      await expect(
        requireCurrentAwsWorkflows({ ...input, provider }, harness("old").ports)
      ).rejects.toThrow("EKS access");
    }
  );
  it.each(["", "unknown"])(
    "refuses an unresolved saved provider %j",
    async (provider) => {
      const h = harness();
      await expect(
        requireCurrentAwsWorkflows(input, {
          ...h.ports,
          environmentProvider: async () => provider
        })
      ).rejects.toThrow("provider");
      expect(h.reads).toEqual([]);
    }
  );
  it("does not trust the hint when reading saved provider configuration fails", async () => {
    await expect(
      requireCurrentAwsWorkflows(
        { ...input, provider: "azure" },
        {
          ...harness().ports,
          environmentProvider: async () => {
            throw new Error("Access denied");
          }
        }
      )
    ).rejects.toThrow("Access denied");
  });
  it("does not inspect unrelated workflow files", async () => {
    const h = harness(null);
    await requireCurrentAwsWorkflows(
      { ...input, files: ["delete-environment.yml"] },
      h.ports
    );
    expect(h.reads).toEqual([]);
  });
  it("refuses an unavailable default branch or packaged template", async () => {
    const h = harness();
    await expect(
      requireCurrentAwsWorkflows(input, {
        ...h.ports,
        defaultBranch: async () => null
      })
    ).rejects.toThrow("default branch");
    await expect(
      requireCurrentAwsWorkflows(input, {
        ...h.ports,
        templates: async () => ({})
      })
    ).rejects.toThrow("unavailable");
  });
  it("refuses a denied read after a successful sync", async () => {
    const h = harness();
    await expect(
      requireCurrentAwsWorkflows(input, {
        ...h.ports,
        readFile: async () => {
          throw new Error("Access denied");
        }
      })
    ).rejects.toThrow("file-unreadable");
  });
});
