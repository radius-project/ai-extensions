import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { buildGitHubTrustPolicy } from "@radius-project/core";
import { createRequestContext } from "../request-context.js";
import { SERVER_ROUTE_DECLARATIONS } from "../route-table.js";
import {
  createAwsDiscoveryRoutes,
  type AwsDiscoveryRouteDependencies
} from "./aws-discovery.js";
import type { CanvasServerEntry } from "../types.js";

const LIST_ROLES = "aws iam list-roles --output json";
const GET_ROLE =
  "aws iam get-role --role-name radius-deploy-octo-api --output json";

function rolesCli(script: Record<string, string | Error>) {
  const calls: string[] = [];
  const runCli: AwsDiscoveryRouteDependencies["runCli"] = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const result = script[line];
    if (result === undefined) throw new Error(`unscripted cli call: ${line}`);
    return result instanceof Error ?
        Promise.reject(result)
      : Promise.resolve(result);
  };
  return { calls, runCli };
}

async function listRoles(
  url: string,
  dependencies: AwsDiscoveryRouteDependencies
): Promise<{ status: number; body: unknown }> {
  const recording = { status: 0, body: "" };
  const response = {
    setHeader() {
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  } as unknown as ServerResponse<IncomingMessage>;
  const request = Object.assign(Readable.from([]), {
    url,
    method: "GET",
    headers: {}
  }) as unknown as IncomingMessage;
  const context = createRequestContext(
    request,
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await createAwsDiscoveryRoutes(dependencies)["GET /api/list-aws-roles"](
    context
  );
  return { status: recording.status, body: JSON.parse(recording.body) };
}

describe("aws-discovery routes", () => {
  it("owns exactly the AWS role list route", () => {
    const routes = createAwsDiscoveryRoutes(rolesCli({}));
    expect(Object.keys(routes)).toEqual(["GET /api/list-aws-roles"]);
    expect(
      SERVER_ROUTE_DECLARATIONS.filter(
        (route) => route.owner === "aws-discovery"
      ).map((route) => `${route.method} ${route.path}`)
    ).toEqual(Object.keys(routes));
  });

  it("answers the roles the repository can use", async () => {
    const cli = rolesCli({
      [LIST_ROLES]: JSON.stringify({
        Roles: [
          {
            RoleName: "radius-deploy-octo-api",
            Arn: "arn:aws:iam::123456789012:role/radius-deploy-octo-api",
            Path: "/",
            AssumeRolePolicyDocument: buildGitHubTrustPolicy("123456789012", [
              "repo:octo/api:environment:dev"
            ])
          }
        ]
      }),
      [GET_ROLE]: JSON.stringify({
        Role: {
          Tags: [
            { Key: "radius-managed", Value: "true" },
            { Key: "radius-repository", Value: "octo/api" }
          ]
        }
      })
    });

    expect(
      await listRoles(
        "/api/list-aws-roles?accountId=123456789012&repo=octo%2Fapi",
        cli
      )
    ).toEqual({
      status: 200,
      body: {
        roles: [
          {
            arn: "arn:aws:iam::123456789012:role/radius-deploy-octo-api",
            name: "radius-deploy-octo-api",
            trustedSubjects: ["repo:octo/api:environment:dev"]
          }
        ]
      }
    });
    expect(cli.calls).toEqual([LIST_ROLES, GET_ROLE]);
  });

  it.each([new Error("AccessDenied"), "AccessDenied"])(
    "answers 400 with an empty role list when listing fails (%s)",
    async (failure) => {
      const runCli: AwsDiscoveryRouteDependencies["runCli"] = () =>
        Promise.reject(failure);
      expect(await listRoles("/api/list-aws-roles", { runCli })).toEqual({
        status: 400,
        body: {
          error: "Failed to list IAM roles: AccessDenied",
          code: "aws-role-list-failed",
          roles: []
        }
      });
    }
  );
});
