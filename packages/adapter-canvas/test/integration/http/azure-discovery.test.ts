import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  isUuid,
  parseServedReposFromSubjects
} from "../../../src/azure-oidc.js";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createAzureDiscoveryRoutes } from "../../../src/server/routes/azure-discovery.js";
import {
  azureDiscoveryContract,
  commandLine,
  temporaryKubeconfigDouble
} from "../../support/azure-discovery-contract.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

const APP_ID = "11111111-2222-3333-4444-555555555555";

const ARGV = {
  list:
    "az ad app list --show-mine --query " +
    "[].{appId:appId,displayName:displayName,createdDateTime:createdDateTime} -o json",
  fic: (appId: string) =>
    `az ad app federated-credential list --id ${appId} --query [].subject -o json`
};

interface AzResult {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

const CLI = {
  aks: commandLine(azureDiscoveryContract().aksList),
  groups: commandLine(azureDiscoveryContract().groupList),
  credentials: (cluster: string, rg: string) =>
    commandLine(
      azureDiscoveryContract({ cluster, resourceGroup: rg }).getCredentials!
    ),
  namespaces: commandLine(
    azureDiscoveryContract({ cluster: "c", resourceGroup: "rg" }).namespaces!
  ),
  eks: "aws eks list-clusters --query clusters --output json",
  vpcs: "aws ec2 describe-vpcs --query Vpcs[].{id:VpcId, name:VpcId} --output json",
  subnets:
    "aws ec2 describe-subnets --query Subnets[].{id:SubnetId, name:SubnetId} --output json"
};

function start(): {
  az: Map<string, AzResult>;
  cli: Map<string, string | { throws: unknown }>;
} {
  const script = new Map<string, AzResult>();
  const cliScript = new Map<string, string | { throws: unknown }>();

  // `runAz` and `runCli` are faked because they are the two seams with real I/O
  // to isolate: scripted maps keyed on the full command line, throwing on
  // anything else. The two predicates are the real `azure-oidc` exports,
  // injected exactly as the production composition root injects them, because
  // they are pure — a double there would control nothing and could only diverge
  // from production.
  const routes = createTestRouteTable(
    createAzureDiscoveryRoutes({
      runAz: (command, args) => {
        const line = [command, ...args].join(" ");
        const scripted = script.get(line);
        if (!scripted) throw new Error(`unscripted az call: ${line}`);
        return Promise.resolve({
          code: scripted.code ?? 0,
          stdout: scripted.stdout ?? "",
          stderr: scripted.stderr ?? ""
        });
      },
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
      },
      isUuid,
      createTemporaryKubeconfig: () => temporaryKubeconfigDouble(),
      parseServedReposFromSubjects: (subjects) =>
        parseServedReposFromSubjects(subjects as Iterable<unknown>)
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

  return { az: script, cli: cliScript };
}

describe("azure-discovery real-loopback HIT (RF-03)", () => {
  it("serves the App Registration picker payload over a real socket", async () => {
    const script = start().az;
    script.set(ARGV.list, {
      stdout: JSON.stringify([
        { appId: "a1", displayName: "App One", createdDateTime: "2024-01-01" },
        { displayName: "no app id" }
      ])
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/list-azure-app-registrations`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"apps":[{"appId":"a1","displayName":"App One","createdDateTime":"2024-01-01"}]}'
    );

    // Only GET is declared, so other methods reach unmatched routing.
    const posted = await fetch(
      `${entry.baseUrl}/api/list-azure-app-registrations`,
      { method: "POST", body: "" }
    );
    expect(posted.status).toBe(404);
  });

  it("computes the serves-repos label and rejects a malformed appId", async () => {
    const script = start().az;
    // A realistic federated-credential subject, so the assertion below pins the
    // real `repo:owner/name:ref:…` -> `owner/name` normalization end to end
    // rather than a passthrough double echoing its own input.
    script.set(ARGV.fic(APP_ID), {
      stdout: '["repo:octo/app:ref:refs/heads/main"]'
    });
    const entry = await container!.getOrCreate("panel-a");

    const labelled = await fetch(
      `${entry.baseUrl}/api/azure-app-serves-repos?appId=${APP_ID}`
    );
    expect(labelled.status).toBe(200);
    expect(labelled.headers.get("content-type")).toBe("application/json");
    expect(await labelled.text()).toBe('{"servesRepos":["octo/app"]}');

    // No `az` entry is scripted for a bad id, so reaching the runner would
    // throw rather than answer 400.
    const rejected = await fetch(
      `${entry.baseUrl}/api/azure-app-serves-repos?appId=nope`
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe(
      '{"error":"A valid appId is required.","code":"app-serves-bad-id"}'
    );
  });

  // The autofix that widened `AzResult.code` to `string | number` was correct:
  // `runCliCommand` resolves `code: err ? err.code || 1 : 0`, and Node reports a
  // spawn failure as a string errno, so a missing `az` really does deliver
  // `"ENOENT"` here. Both handlers compare strictly against `0`, so a string
  // takes the failure arm exactly as `1` would -- but nothing over the wire
  // exercised that until now, which left the widened type unused.
  it("treats a string spawn errno as a failure on both routes", async () => {
    const script = start().az;
    script.set(ARGV.list, {
      code: "ENOENT",
      stdout: "[]",
      stderr: "az: command not found"
    });
    script.set(ARGV.fic(APP_ID), {
      code: "ENOENT",
      stdout: '["repo:octo/app:ref:refs/heads/main"]'
    });
    const entry = await container!.getOrCreate("panel-a");

    const listed = await fetch(
      `${entry.baseUrl}/api/list-azure-app-registrations`
    );
    expect(listed.status).toBe(400);
    expect(await listed.text()).toBe(
      '{"error":"Failed to list App Registrations: az: command not found","code":"app-list-failed","azError":"az: command not found"}'
    );

    // Answers `null` rather than `[]`: the label is unavailable, which is a
    // different answer from "serves no repos". The scripted stdout would have
    // parsed cleanly, so a 200 here would mean the failure check was skipped.
    const served = await fetch(
      `${entry.baseUrl}/api/azure-app-serves-repos?appId=${APP_ID}`
    );
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('{"servesRepos":null}');
  });

  it("enumerates azure resources over a real socket", async () => {
    const { cli } = start();
    cli.set(
      CLI.aks,
      JSON.stringify([
        { id: "aks-first", name: "aks-first", resourceGroup: "rg-first" },
        {
          id: "aks-selected",
          name: "aks-selected",
          resourceGroup: "rg-selected"
        }
      ])
    );
    cli.set(
      CLI.groups,
      JSON.stringify([
        { id: "rg-first", name: "rg-first" },
        { id: "rg-selected", name: "rg-selected" }
      ])
    );
    cli.set(CLI.credentials("aks-selected", "rg-selected"), "");
    cli.set(CLI.namespaces, '"default" "radius-system"');
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/discover`, {
      method: "POST",
      body: JSON.stringify({
        provider: "azure",
        resourceGroup: "rg-selected",
        cluster: "aks-selected"
      })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"clusters":[{"id":"aks-first","name":"aks-first","resourceGroup":"rg-first"},' +
        '{"id":"aks-selected","name":"aks-selected","resourceGroup":"rg-selected"}],' +
        '"resourceGroups":[{"id":"rg-first","name":"rg-first","resourceGroup":""},' +
        '{"id":"rg-selected","name":"rg-selected","resourceGroup":""}],' +
        '"namespaces":["default","radius-system"],"vpcs":[],"subnets":[]}'
    );

    // Only POST is declared, so a GET reaches unmatched routing.
    const got = await fetch(`${entry.baseUrl}/api/discover`);
    expect(got.status).toBe(404);
  });

  it("answers 200 with the refusal shape for unsafe discovery inputs and a bad body", async () => {
    // Nothing is scripted on `runCli`, so any spawn attempt throws: both of
    // these must be refused before the CLI is reached.
    start();
    const entry = await container!.getOrCreate("panel-a");

    const refused = await fetch(`${entry.baseUrl}/api/discover`, {
      method: "POST",
      body: JSON.stringify({ provider: "azure", subscriptionId: "x&calc" })
    });
    expect(refused.status).toBe(200);
    expect(refused.headers.get("content-type")).toBe("application/json");
    expect(await refused.text()).toBe(
      '{"error":"Invalid subscriptionId \\"x&calc\\" (expected a GUID).",' +
        '"clusters":[],"resourceGroups":[],"namespaces":[],"vpcs":[],"subnets":[]}'
    );

    const unsafeTarget = await fetch(`${entry.baseUrl}/api/discover`, {
      method: "POST",
      body: JSON.stringify({
        provider: "azure",
        resourceGroup: 'rg" & whoami & "',
        cluster: "-aks-option"
      })
    });
    expect(unsafeTarget.status).toBe(200);
    expect(await unsafeTarget.text()).toBe(
      '{"error":"Invalid Azure resource group name.",' +
        '"clusters":[],"resourceGroups":[],"namespaces":[],"vpcs":[],"subnets":[]}'
    );

    const malformed = await fetch(`${entry.baseUrl}/api/discover`, {
      method: "POST",
      body: "not json"
    });
    expect(malformed.status).toBe(200);
    const parsed = (await malformed.json()) as { error: string };
    expect(parsed.error.length).toBeGreaterThan(0);
    expect(parsed).toMatchObject({
      clusters: [],
      resourceGroups: [],
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    });
  });

  it("reports a failing aws enumeration as a partial result rather than an error status", async () => {
    const { cli } = start();
    cli.set(CLI.eks, '["eks-1"]');
    cli.set(CLI.vpcs, { throws: new Error("vpcs denied") });
    cli.set(CLI.subnets, "[]");
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/discover`, {
      method: "POST",
      body: JSON.stringify({ provider: "aws" })
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '{"clusters":[{"id":"eks-1","name":"eks-1"}],"resourceGroups":[],' +
        '"namespaces":["default","kube-system","radius-system"],"vpcs":[],"subnets":[],' +
        '"errors":{"vpcs":"vpcs denied"}}'
    );
  });
});
