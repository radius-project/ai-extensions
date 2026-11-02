import { createServer } from "node:http";
import { buildGitHubTrustPolicy } from "@radius-project/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createAwsDiscoveryRoutes } from "../../../src/server/routes/aws-discovery.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

// `runCli` is the only seam with real I/O: a scripted map keyed on the full
// command line that throws on anything else.
function start(): Map<string, string | { throws: unknown }> {
  const cliScript = new Map<string, string | { throws: unknown }>();
  const routes = createTestRouteTable(
    createAwsDiscoveryRoutes({
      runCli: (command, args) => {
        const line = [command, ...args].join(" ");
        const scripted = cliScript.get(line);
        if (scripted === undefined) {
          throw new Error(`unscripted cli call: ${line}`);
        }
        if (typeof scripted !== "string") {
          return Promise.reject(scripted.throws);
        }
        return Promise.resolve(scripted);
      }
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return cliScript;
}

describe("aws-discovery real-loopback list-aws-roles", () => {
  const account = "123456789012";
  const listRoles = "aws iam list-roles --output json";
  const githubRole = (name: string, subject: string) => ({
    RoleName: name,
    Arn: `arn:aws:iam::${account}:role/${name}`,
    AssumeRolePolicyDocument: buildGitHubTrustPolicy(account, [subject])
  });
  const getRole = (name: string) =>
    `aws iam get-role --role-name ${name} --output json`;
  const tagged = (repo: string) =>
    JSON.stringify({
      Role: {
        Tags: [
          { Key: "Radius-Managed", Value: "true" },
          { Key: "radius-repository", Value: repo }
        ]
      }
    });

  it("decodes the repo query and leaves out another repository's IAM role", async () => {
    const cli = start();
    cli.set(
      listRoles,
      JSON.stringify({
        Roles: [
          {
            RoleName: "app-runtime",
            Arn: `arn:aws:iam::${account}:role/app-runtime`,
            AssumeRolePolicyDocument: {
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole"
                }
              ]
            }
          },
          githubRole("radius-deploy-octo-api", "repo:octo/api:environment:dev"),
          githubRole(
            "radius-deploy-octo-shop",
            "repo:octo/shop:environment:dev"
          )
        ]
      })
    );
    cli.set(getRole("radius-deploy-octo-api"), tagged("octo/api"));
    cli.set(getRole("radius-deploy-octo-shop"), tagged("octo/shop"));
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/list-aws-roles?accountId=${account}&repo=octo%2Fshop`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      roles: [
        {
          arn: `arn:aws:iam::${account}:role/radius-deploy-octo-shop`,
          name: "radius-deploy-octo-shop",
          trustedSubjects: ["repo:octo/shop:environment:dev"]
        },
        {
          arn: `arn:aws:iam::${account}:role/app-runtime`,
          name: "app-runtime",
          trustedSubjects: []
        }
      ]
    });
  });

  it("answers 400 with the AWS error when a GitHub role's tags cannot be read", async () => {
    const cli = start();
    cli.set(
      listRoles,
      JSON.stringify({
        Roles: [
          githubRole("radius-deploy-octo-api", "repo:octo/api:environment:dev"),
          githubRole(
            "radius-deploy-octo-shop",
            "repo:octo/shop:environment:dev"
          )
        ]
      })
    );
    cli.set(getRole("radius-deploy-octo-api"), {
      throws: new Error("AccessDenied: iam:GetRole")
    });
    cli.set(getRole("radius-deploy-octo-shop"), tagged("octo/shop"));
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/list-aws-roles?accountId=${account}&repo=octo%2Fshop`
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Failed to list IAM roles: AccessDenied: iam:GetRole",
      code: "aws-role-list-failed",
      roles: []
    });
  });
});
