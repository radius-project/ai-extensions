import { describe, expect, it } from "vitest";
import {
  claimantFromVariables,
  createGhNamespaceClaimsPorts,
  createSelectedNamespaceClaimsPorts,
  DEFAULT_NAMESPACE,
  findNamespaceClaimConflict,
  loadNamespaceClaims,
  type ClaimantReading,
  type NamespaceClaimsCliExec,
  type NamespaceClaimsRunner,
  type NamespaceClaim,
  type NamespaceClaimant,
  type NamespaceClaimsPorts
} from "./create-environment-namespace-claims.js";

function azureVariables(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    RADIUS_MANAGED: "true",
    AZURE_CLIENT_ID: "client-1",
    AZURE_SUBSCRIPTION_ID: "sub-1",
    AZURE_AKS_CLUSTER_NAME: "aks-1",
    KUBERNETES_NAMESPACE: "payments",
    ...overrides
  };
}

function awsVariables(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    RADIUS_MANAGED: "true",
    AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/radius",
    AWS_ACCOUNT_ID: "111122223333",
    AWS_REGION: "us-east-1",
    AWS_EKS_CLUSTER_NAME: "eks-1",
    KUBERNETES_NAMESPACE: "payments",
    ...overrides
  };
}

function namespaceOf(reading: ClaimantReading): string | null {
  return reading.kind === "claim" ? reading.claimant.namespace : null;
}

function claimant(
  overrides: Partial<NamespaceClaimant> = {}
): NamespaceClaimant {
  return {
    environment: "dev",
    provider: "azure",
    subscriptionId: "sub-1",
    accountId: "",
    region: "",
    cluster: "aks-1",
    namespace: "payments",
    ...overrides
  };
}

function claim(overrides: Partial<NamespaceClaim> = {}): NamespaceClaim {
  return {
    provider: "azure",
    subscriptionId: "sub-1",
    accountId: "",
    region: "",
    cluster: "aks-1",
    namespace: "payments",
    excludeEnvironment: "",
    ...overrides
  };
}

/** Ports whose every call is scripted; anything unscripted throws. */
function ports(
  environments: Record<string, Record<string, string>>,
  failures: { names?: string; variables?: string } = {}
): NamespaceClaimsPorts {
  return {
    listEnvironmentNames: async () =>
      failures.names ?
        { ok: false, reason: failures.names }
      : { ok: true, names: Object.keys(environments) },
    readEnvironmentVariables: async (_repo, environment) => {
      if (failures.variables) {
        return { ok: false, reason: failures.variables };
      }
      const variables = environments[environment];
      if (!variables) throw new Error(`unscripted read of ${environment}`);
      return { ok: true, variables };
    }
  };
}

describe("reading a namespace claim from an environment's variables", () => {
  it("reads the Azure identity, cluster, and namespace", () => {
    expect(claimantFromVariables("dev", azureVariables())).toEqual({
      kind: "claim",
      claimant: {
        environment: "dev",
        provider: "azure",
        subscriptionId: "sub-1",
        accountId: "",
        region: "",
        cluster: "aks-1",
        namespace: "payments"
      }
    });
  });

  it("reads the AWS identity, cluster, and namespace", () => {
    expect(claimantFromVariables("prod", awsVariables())).toEqual({
      kind: "claim",
      claimant: {
        environment: "prod",
        provider: "aws",
        subscriptionId: "",
        accountId: "111122223333",
        region: "us-east-1",
        cluster: "eks-1",
        namespace: "payments"
      }
    });
  });

  // An environment this extension did not create holds no Radius claim.
  it("ignores an environment that is not Radius-managed", () => {
    const variables = azureVariables();
    delete variables.RADIUS_MANAGED;
    expect(claimantFromVariables("manual", variables)).toEqual({
      kind: "unmanaged"
    });
  });

  // Presence is the marker, matching the listing route. A tag that exists with
  // an empty value still marks a managed environment, and dropping it would
  // hide a real claim and admit the duplicate.
  // A managed environment whose provider or cluster cannot be read might hold
  // exactly the namespace being requested. Reporting it as "no claim" is the
  // fail-open the gate exists to prevent, so the reading is indeterminate and
  // the caller refuses.
  it.each([
    ["no provider marker", ["AZURE_CLIENT_ID"], "its cloud provider"],
    ["no cluster", ["AZURE_AKS_CLUSTER_NAME"], "its cluster"]
  ])(
    "cannot determine a claim for a managed environment with %s",
    (_label, dropped, missing) => {
      const variables = azureVariables();
      for (const name of dropped) delete variables[name];
      expect(claimantFromVariables("dev", variables)).toEqual({
        kind: "indeterminate",
        missing
      });
    }
  );

  it("treats a whitespace-only cluster as no cluster", () => {
    expect(
      claimantFromVariables(
        "dev",
        azureVariables({ AZURE_AKS_CLUSTER_NAME: " " })
      )
    ).toEqual({ kind: "indeterminate", missing: "its cluster" });
  });

  // Provider comes from the repository's single source of truth, not from
  // whichever cluster variable happens to be present, so this environment
  // classifies the same way the listing and delete flows classify it.
  it("classifies the provider from the canonical marker, not the cluster name", () => {
    const variables = awsVariables();
    delete variables.AWS_EKS_CLUSTER_NAME;
    variables.AZURE_AKS_CLUSTER_NAME = "aks-1";
    expect(claimantFromVariables("prod", variables)).toEqual({
      kind: "indeterminate",
      missing: "its cluster"
    });
  });

  it("still claims for an environment whose managed tag is empty", () => {
    expect(
      namespaceOf(
        claimantFromVariables("dev", azureVariables({ RADIUS_MANAGED: "" }))
      )
    ).toBe("payments");
  });

  // The workflow resolves an absent or empty namespace to "default", so two
  // environments that both leave it unset really do collide.
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   "]
  ])("treats an %s namespace as the default", (_label, value) => {
    const variables = azureVariables();
    delete variables.KUBERNETES_NAMESPACE;
    if (value !== undefined) variables.KUBERNETES_NAMESPACE = value;
    expect(namespaceOf(claimantFromVariables("dev", variables))).toBe(
      DEFAULT_NAMESPACE
    );
  });

  it("still reads the namespace of an environment predating the rename", () => {
    const variables = azureVariables();
    delete variables.KUBERNETES_NAMESPACE;
    variables.RADIUS_NAMESPACE = "legacy-ns";
    expect(namespaceOf(claimantFromVariables("dev", variables))).toBe(
      "legacy-ns"
    );
  });

  // Presence decides, matching how the listing and the workflow resolve it.
  it("prefers an existing current variable over a superseded one", () => {
    expect(
      namespaceOf(
        claimantFromVariables(
          "dev",
          azureVariables({
            KUBERNETES_NAMESPACE: "",
            RADIUS_NAMESPACE: "stale"
          })
        )
      )
    ).toBe(DEFAULT_NAMESPACE);
  });
});

describe("matching a namespace claim", () => {
  it("reports the environment holding the namespace on the same cluster", () => {
    expect(findNamespaceClaimConflict([claimant()], claim())?.environment).toBe(
      "dev"
    );
  });

  it("compares identity ignoring case and padding", () => {
    expect(
      findNamespaceClaimConflict(
        [claimant()],
        claim({
          cluster: " AKS-1 ",
          namespace: "Payments",
          subscriptionId: "SUB-1"
        })
      )?.environment
    ).toBe("dev");
  });

  // The identity gap willtsai raised: same cluster name, different account.
  it("allows the same cluster name in another Azure subscription", () => {
    expect(
      findNamespaceClaimConflict(
        [claimant()],
        claim({ subscriptionId: "sub-2" })
      )
    ).toBeNull();
  });

  it.each([
    ["account", { accountId: "444455556666" }],
    ["region", { region: "eu-west-1" }]
  ])("allows the same EKS cluster name in another %s", (_label, difference) => {
    const listed = claimant({
      provider: "aws",
      subscriptionId: "",
      accountId: "111122223333",
      region: "us-east-1",
      cluster: "eks-1"
    });
    const requested = claim({
      provider: "aws",
      subscriptionId: "",
      accountId: "111122223333",
      region: "us-east-1",
      cluster: "eks-1",
      ...difference
    });
    expect(findNamespaceClaimConflict([listed], requested)).toBeNull();
  });

  it("reports a genuine duplicate in the same AWS account and region", () => {
    const listed = claimant({
      provider: "aws",
      subscriptionId: "",
      accountId: "111122223333",
      region: "us-east-1",
      cluster: "eks-1"
    });
    const requested = claim({
      provider: "aws",
      subscriptionId: "",
      accountId: "111122223333",
      region: "us-east-1",
      cluster: "eks-1"
    });
    expect(findNamespaceClaimConflict([listed], requested)?.environment).toBe(
      "dev"
    );
  });

  it.each([
    ["cluster", { cluster: "aks-2" }],
    ["namespace", { namespace: "orders" }],
    ["provider", { provider: "aws" }]
  ])("allows a different %s", (_label, difference) => {
    expect(
      findNamespaceClaimConflict([claimant()], claim(difference))
    ).toBeNull();
  });

  it("does not conflict the environment being saved with itself", () => {
    expect(
      findNamespaceClaimConflict(
        [claimant()],
        claim({ excludeEnvironment: "DEV" })
      )
    ).toBeNull();
  });

  it("still reports another environment while one is being saved", () => {
    expect(
      findNamespaceClaimConflict(
        [claimant(), claimant({ environment: "staging" })],
        claim({ excludeEnvironment: "dev" })
      )?.environment
    ).toBe("staging");
  });

  // Two environments that both omit the namespace land on the same one.
  it("treats an unspecified requested namespace as the default", () => {
    expect(
      findNamespaceClaimConflict(
        [claimant({ namespace: DEFAULT_NAMESPACE })],
        claim({ namespace: "" })
      )?.environment
    ).toBe("dev");
  });

  it("claims nothing without a cluster", () => {
    expect(
      findNamespaceClaimConflict([claimant()], claim({ cluster: " " }))
    ).toBeNull();
  });

  // An account neither side can produce distinguishes nothing, so the two are
  // held to be the same cluster. Requiring equality here would admit a
  // duplicate whenever an identity was missing, which is the wrong direction
  // for a gate that exists to fail closed.
  it.each([
    [
      "the held claim records no subscription",
      { subscriptionId: "" },
      { subscriptionId: "sub-1" }
    ],
    [
      "the request carries no subscription",
      { subscriptionId: "sub-1" },
      { subscriptionId: "" }
    ]
  ])("still conflicts when %s", (_label, held, requested) => {
    expect(
      findNamespaceClaimConflict([claimant(held)], claim(requested))
        ?.environment
    ).toBe("dev");
  });

  it("still conflicts when an AWS claim records no account or region", () => {
    const held = claimant({
      provider: "aws",
      subscriptionId: "",
      accountId: "",
      region: "",
      cluster: "eks-1"
    });
    const requested = claim({
      provider: "aws",
      subscriptionId: "",
      accountId: "111122223333",
      region: "us-east-1",
      cluster: "eks-1"
    });
    expect(findNamespaceClaimConflict([held], requested)?.environment).toBe(
      "dev"
    );
  });

  it("finds no conflict among no claims", () => {
    expect(findNamespaceClaimConflict([], claim())).toBeNull();
  });
});

describe("the gh-backed claims ports", () => {
  interface Call {
    command: string;
    args: string[];
  }

  function cliFake(
    responses: Record<
      string,
      { stdout?: string; error?: Error; stderr?: string }
    >
  ): { exec: NamespaceClaimsCliExec; calls: Call[] } {
    const calls: Call[] = [];
    const exec: NamespaceClaimsCliExec = (
      command,
      args,
      _options,
      callback
    ) => {
      calls.push({ command, args });
      const key = args.find((arg) => arg.startsWith("/repos/")) ?? "";
      const scripted = responses[key];
      if (!scripted) throw new Error(`unscripted gh call: ${key}`);
      callback(
        scripted.error ?? null,
        scripted.stdout ?? "",
        scripted.stderr ?? ""
      );
      return undefined;
    };
    return { exec, calls };
  }

  const NAMES_PATH = "/repos/octo/app/environments?per_page=100";
  const VARS_PATH = "/repos/octo/app/environments/dev/variables?per_page=100";

  // A CRLF stdout from a Windows host must not leave a stray carriage return on
  // the last name or the last variable's value: both feed identity comparisons
  // and the message the customer reads.
  it("reads CRLF-terminated environment names without a stray carriage return", async () => {
    const { exec } = cliFake({ [NAMES_PATH]: { stdout: "dev\r\nprod\r\n" } });

    await expect(
      createGhNamespaceClaimsPorts(exec).listEnvironmentNames("octo/app")
    ).resolves.toEqual({ ok: true, names: ["dev", "prod"] });
  });

  it("reads CRLF-terminated variables through the shared parser", async () => {
    const { exec } = cliFake({
      [VARS_PATH]: {
        stdout:
          "RADIUS_MANAGED\ttrue\r\nAZURE_CLIENT_ID\tclient-1\r\nAZURE_AKS_CLUSTER_NAME\taks-1\r\nKUBERNETES_NAMESPACE\tpayments\r\n"
      }
    });

    const result = await createGhNamespaceClaimsPorts(
      exec
    ).readEnvironmentVariables("octo/app", "dev");

    expect(result).toEqual({
      ok: true,
      variables: {
        RADIUS_MANAGED: "true",
        AZURE_CLIENT_ID: "client-1",
        AZURE_AKS_CLUSTER_NAME: "aks-1",
        KUBERNETES_NAMESPACE: "payments"
      }
    });
  });

  // A decision made on a truncated page could miss the variables that
  // establish a claim.
  it.each([
    [
      "environment names",
      NAMES_PATH,
      (p: NamespaceClaimsPorts) => p.listEnvironmentNames("octo/app")
    ],
    [
      "environment variables",
      VARS_PATH,
      (p: NamespaceClaimsPorts) => p.readEnvironmentVariables("octo/app", "dev")
    ]
  ])("paginates the %s request", async (_label, path, call) => {
    const { exec, calls } = cliFake({ [path]: { stdout: "" } });

    await call(createGhNamespaceClaimsPorts(exec));

    expect(calls[0].command).toBe("gh");
    expect(calls[0].args).toContain("--paginate");
  });

  it.each([
    [
      "environment names",
      NAMES_PATH,
      (p: NamespaceClaimsPorts) => p.listEnvironmentNames("octo/app"),
      "gh: forbidden"
    ],
    [
      "environment variables",
      VARS_PATH,
      (p: NamespaceClaimsPorts) =>
        p.readEnvironmentVariables("octo/app", "dev"),
      "gh: forbidden"
    ]
  ])(
    "reports a %s failure as a failure rather than an empty result",
    async (_label, path, call, expected) => {
      const { exec } = cliFake({
        [path]: { error: new Error("exit 1"), stderr: "gh: forbidden" }
      });

      await expect(call(createGhNamespaceClaimsPorts(exec))).resolves.toEqual({
        ok: false,
        reason: expected
      });
    }
  );

  it("falls back to a readable reason when gh says nothing", async () => {
    const { exec } = cliFake({
      [NAMES_PATH]: { error: Object.assign(new Error(""), { code: 1 }) }
    });

    await expect(
      createGhNamespaceClaimsPorts(exec).listEnvironmentNames("octo/app")
    ).resolves.toEqual({
      ok: false,
      reason: "the environment list could not be read."
    });
  });
});

describe("the pinned-account claims ports", () => {
  function executorFake(
    result: { code?: string | number; stdout?: string; stderr?: string } | Error
  ): { executor: NamespaceClaimsRunner; args: string[][] } {
    const args: string[][] = [];
    return {
      args,
      executor: {
        run: async (called) => {
          args.push(called);
          if (result instanceof Error) throw result;
          return {
            code: result.code ?? 0,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? ""
          };
        }
      }
    };
  }

  it("reads variables through the selected account", async () => {
    const { executor, args } = executorFake({
      stdout: "RADIUS_MANAGED\ttrue\r\nAZURE_CLIENT_ID\tclient-1\r\n"
    });

    const result = await createSelectedNamespaceClaimsPorts(
      executor
    ).readEnvironmentVariables("octo/app", "dev");

    expect(result).toEqual({
      ok: true,
      variables: { RADIUS_MANAGED: "true", AZURE_CLIENT_ID: "client-1" }
    });
    expect(args[0]).toContain("--paginate");
  });

  // The selected account can be denied the repository as readily as any other,
  // and that has to read as a failure rather than an empty claim set.
  it("reports a non-zero exit as a failure", async () => {
    const { executor } = executorFake({ code: 1, stderr: "gh: forbidden" });

    await expect(
      createSelectedNamespaceClaimsPorts(executor).listEnvironmentNames(
        "octo/app"
      )
    ).resolves.toEqual({ ok: false, reason: "gh: forbidden" });
  });

  it("reports a thrown executor error as a failure", async () => {
    const { executor } = executorFake(new Error("token expired"));

    await expect(
      createSelectedNamespaceClaimsPorts(executor).listEnvironmentNames(
        "octo/app"
      )
    ).resolves.toEqual({ ok: false, reason: "token expired" });
  });
});

describe("establishing the repository's namespace claims", () => {
  it("collects a claim for each managed environment", async () => {
    const result = await loadNamespaceClaims(
      "octo/app",
      ports({
        dev: azureVariables(),
        prod: awsVariables({ KUBERNETES_NAMESPACE: "orders" }),
        manual: { AZURE_AKS_CLUSTER_NAME: "aks-9" }
      })
    );

    expect(result).toEqual({
      ok: true,
      claims: [
        claimant(),
        claimant({
          environment: "prod",
          provider: "aws",
          subscriptionId: "",
          accountId: "111122223333",
          region: "us-east-1",
          cluster: "eks-1",
          namespace: "orders"
        })
      ]
    });
  });

  // The admission boundary sits in front of every create, so the reads must not
  // fan out one call per environment at once on a repository with many of them.
  it("bounds how many variable reads are in flight at once", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `env-${index}`);
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const ports: NamespaceClaimsPorts = {
      listEnvironmentNames: async () => ({ ok: true, names }),
      readEnvironmentVariables: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return { ok: true, variables: azureVariables() };
      }
    };

    const pending = loadNamespaceClaims("octo/app", ports);
    // Let every started read finish, repeatedly, until the work drains.
    for (let pass = 0; pass < names.length + 1; pass += 1) {
      await Promise.resolve();
      for (const resolve of release.splice(0)) resolve();
      await Promise.resolve();
    }
    await pending;

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  // Which failure is reported must not depend on which call returns first.
  it("reports the first failure in name order, not in completion order", async () => {
    const ports: NamespaceClaimsPorts = {
      listEnvironmentNames: async () => ({
        ok: true,
        names: ["alpha", "beta"]
      }),
      readEnvironmentVariables: async (_repo, environment) => {
        if (environment === "beta") {
          return { ok: false, reason: "beta failed first" };
        }
        // Resolves later than beta, but is earlier in name order.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: false, reason: "alpha failed second" };
      }
    };

    await expect(loadNamespaceClaims("octo/app", ports)).resolves.toEqual({
      ok: false,
      reason: "alpha failed second"
    });
  });

  it("reports no claims for a repository with no environments", async () => {
    await expect(loadNamespaceClaims("octo/app", ports({}))).resolves.toEqual({
      ok: true,
      claims: []
    });
  });

  // Failing closed is the whole point: "could not ask" must never be
  // indistinguishable from "nothing claimed".
  it("fails when the environment list cannot be read", async () => {
    await expect(
      loadNamespaceClaims("octo/app", ports({}, { names: "gh: forbidden" }))
    ).resolves.toEqual({ ok: false, reason: "gh: forbidden" });
  });

  it("fails when any environment's variables cannot be read", async () => {
    await expect(
      loadNamespaceClaims(
        "octo/app",
        ports({ dev: azureVariables() }, { variables: "gh: rate limited" })
      )
    ).resolves.toEqual({ ok: false, reason: "gh: rate limited" });
  });

  // A managed environment Radius cannot describe stops the whole answer, for
  // the same reason an unreadable one does.
  it("fails when a managed environment does not record its cluster", async () => {
    const incomplete = azureVariables();
    delete incomplete.AZURE_AKS_CLUSTER_NAME;

    await expect(
      loadNamespaceClaims("octo/app", ports({ dev: incomplete }))
    ).resolves.toEqual({
      ok: false,
      reason: 'environment "dev" does not record its cluster.'
    });
  });

  it("still collects claims when an unmanaged environment is incomplete", async () => {
    await expect(
      loadNamespaceClaims(
        "octo/app",
        ports({ dev: azureVariables(), manual: { SOMETHING_ELSE: "x" } })
      )
    ).resolves.toEqual({ ok: true, claims: [claimant()] });
  });
});
