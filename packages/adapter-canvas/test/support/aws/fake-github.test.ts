import { describe, expect, it } from "vitest";
import { FakeGitHub } from "./fake-github.js";

function github() {
  const fake = new FakeGitHub("octo/shop", 42, 7);
  fake.addEnvironment("dev", { AWS_REGION: "us-west-2" });
  return fake;
}

describe("FakeGitHub", () => {
  it("reads the repository, its OIDC customization, and its environments", () => {
    const fake = github();
    expect(fake.readJson("/repos/octo/shop")).toEqual({
      ok: true,
      status: 200,
      json: {
        full_name: "octo/shop",
        id: 42,
        owner: { id: 7 },
        permissions: { admin: true }
      },
      stderr: ""
    });
    expect(
      fake.readJson("/repos/octo/shop/actions/oidc/customization/sub").json
    ).toEqual({ use_default: true, use_immutable_subject: false });
    expect(fake.readJson("/repos/octo/shop/environments").json).toEqual({
      total_count: 1,
      environments: [{ name: "dev", id: 17 }]
    });
    expect(fake.readJson("/repos/octo/shop/environments/DEV").json).toEqual({
      name: "dev",
      id: 17
    });
    expect(
      fake.readJson("/repos/octo/shop/environments/dev/variables?per_page=100")
        .json
    ).toEqual({
      total_count: 1,
      variables: [{ name: "AWS_REGION", value: "us-west-2" }]
    });
  });

  it("answers 404 for an environment or variable that is not there", () => {
    const fake = github();
    expect(fake.readJson("/repos/octo/shop/environments/prod")).toMatchObject({
      ok: false,
      status: 404
    });
    expect(
      fake.gh(["api", "/repos/octo/shop/environments/dev/variables/MISSING"])
    ).toMatchObject({ code: 1, stderr: "gh: Not Found (HTTP 404)" });
  });

  it("sets a variable through gh, and reads it back", () => {
    const fake = github();
    const set = (repo: string, env: string) =>
      fake.gh([
        "variable",
        "set",
        "AWS_ROLE_ARN",
        "--body",
        "arn",
        "--env",
        env,
        "--repo",
        repo
      ]);
    expect(set("octo/shop", "dev").code).toBe(0);
    expect(set("octo/other", "dev").code).toBe(1);
    expect(set("octo/shop", "prod").code).toBe(1);
    expect(
      JSON.parse(
        fake.gh([
          "api",
          "/repos/octo/shop/environments/dev/variables/AWS_ROLE_ARN"
        ]).stdout
      )
    ).toEqual({ name: "AWS_ROLE_ARN", value: "arn" });
    expect(fake.snapshot()).toEqual({
      dev: { AWS_REGION: "us-west-2", AWS_ROLE_ARN: "arn" }
    });
  });

  it("deletes a variable through gh variable delete", () => {
    const fake = github();
    const del = () =>
      fake.gh([
        "variable",
        "delete",
        "AWS_REGION",
        "--env",
        "dev",
        "--repo",
        "octo/shop"
      ]);
    expect(del().code).toBe(0);
    expect(del().code).toBe(1);
    expect(fake.snapshot()).toEqual({ dev: {} });
  });

  it("deletes a variable and an environment through gh", () => {
    const fake = github();
    const del = (path: string) => fake.gh(["api", "--method", "DELETE", path]);
    expect(
      del("/repos/octo/shop/environments/dev/variables/AWS_REGION").code
    ).toBe(0);
    expect(
      del("/repos/octo/shop/environments/dev/variables/AWS_REGION").code
    ).toBe(1);
    expect(del("/repos/octo/shop/environments/dev").code).toBe(0);
    expect(del("/repos/octo/shop/environments/dev").code).toBe(1);
    expect(fake.snapshot()).toEqual({});
  });

  it("deletes an environment through the delete port, once", () => {
    const fake = github();
    expect(fake.deleteEnvironment("DEV")).toBe("deleted");
    expect(fake.deleteEnvironment("dev")).toBe("not_found");
  });

  it("tells writes from reads", () => {
    expect(FakeGitHub.isWrite(["variable", "set", "X"])).toBe(true);
    expect(FakeGitHub.isWrite(["variable", "list"])).toBe(false);
    expect(FakeGitHub.isWrite(["variable", "get", "X"])).toBe(false);
    expect(FakeGitHub.isWrite(["api", "-X", "PUT", "/x"])).toBe(true);
    expect(FakeGitHub.isWrite(["api", "/x"])).toBe(false);
  });

  it("throws on a call it has no answer for, so a test sees it", () => {
    const fake = github();
    expect(() => fake.gh(["pr", "list"])).toThrow("no answer for gh pr list");
    expect(() => fake.gh(["api", "-X", "PUT", "/repos/octo/shop"])).toThrow(
      "no answer"
    );
    expect(() => fake.readJson("/repos/octo/shop/pulls")).toThrow(
      "no answer for GET"
    );
    expect(() =>
      fake.gh(["api", "--method", "DELETE", "/repos/octo/shop"])
    ).toThrow("no answer for DELETE");
  });
});
