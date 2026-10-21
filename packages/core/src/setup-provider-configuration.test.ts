import { describe, expect, it } from "vitest";
import {
  applySetupProviderConfiguration,
  azureRoleScope,
  cloudCredentialsComplete,
  setupProviderCredentialStatus,
  type SetupProviderConfigurationInput,
  type SetupProviderConfigurationPorts
} from "./setup-provider-configuration.js";

const azureInput = {
  clientId: "client",
  tenantId: "tenant",
  subscriptionId: "sub",
  resourceGroup: "app-rg",
  clusterResourceGroup: "cluster-rg",
  cluster: "aks",
  location: "westus2",
  namespace: "radius"
};
const azureWrites = [
  ["AZURE_CLIENT_ID", "client"],
  ["AZURE_TENANT_ID", "tenant"],
  ["AZURE_SUBSCRIPTION_ID", "sub"],
  ["AZURE_RESOURCE_GROUP", "app-rg"],
  ["AZURE_AKS_CLUSTER_NAME", "aks"],
  ["AZURE_AKS_RESOURCE_GROUP", "cluster-rg"],
  ["AZURE_LOCATION", "westus2"],
  ["KUBERNETES_NAMESPACE", "radius"]
];
const awsInput = {
  roleArn: "arn:aws:iam::1:role/r",
  region: "eu-west-1",
  accountId: "1",
  cluster: "eks",
  vpcId: "vpc",
  subnetIds: "subnet",
  namespace: "radius"
};
const awsWrites = [
  ["AWS_ROLE_ARN", awsInput.roleArn],
  ["AWS_REGION", "eu-west-1"],
  ["AWS_ACCOUNT_ID", "1"],
  ["AWS_EKS_CLUSTER_NAME", "eks"],
  ["RADIUS_VPC_ID", "vpc"],
  ["RADIUS_SUBNET_IDS", "subnet"],
  ["KUBERNETES_NAMESPACE", "radius"]
];
const start = ["event", { kind: "configuration-started" }];

function recorder(overrides: Partial<SetupProviderConfigurationPorts> = {}) {
  const calls: unknown[][] = [];
  const ports: SetupProviderConfigurationPorts = {
    azureCredential: () => {
      calls.push(["read", "azure"]);
      return {};
    },
    awsCredential: () => {
      calls.push(["read", "aws"]);
      return {};
    },
    optionalString: (value) => {
      calls.push(["optional", value]);
      return typeof value === "string" ? value : "";
    },
    setEnvironmentVariable: async (name, value) => {
      calls.push(["write", name, value]);
      return false;
    },
    report: (event) => {
      calls.push(["event", event]);
    },
    ...overrides
  };
  return { calls, ports };
}

describe("setup provider configuration", () => {
  it.each([
    {
      provider: "azure",
      input: azureInput,
      reads: [
        ["read", "azure"],
        ["read", "aws"],
        ["read", "azure"]
      ],
      writes: azureWrites,
      events: [
        ["event", { kind: "azure-values-configured", count: 8 }],
        [
          "event",
          {
            kind: "azure-role-guidance",
            assignee: "client",
            scope: "/subscriptions/sub/resourceGroups/app-rg"
          }
        ]
      ]
    },
    {
      provider: "aws",
      input: awsInput,
      reads: [
        ["read", "azure"],
        ["read", "aws"]
      ],
      writes: awsWrites,
      events: []
    }
  ])(
    "preserves the complete $provider transcript despite false write returns",
    async ({ provider, input, reads, writes, events }) => {
      const { calls, ports } = recorder();
      expect(
        await applySetupProviderConfiguration(provider, input, ports)
      ).toEqual({
        provider,
        credentialsComplete: true
      });
      expect(calls).toEqual([
        start,
        ...reads,
        ...writes.map((write) => ["write", ...write]),
        ...events
      ]);
    }
  );

  it("uses first-read Azure values for writes and an independent read for readiness", async () => {
    let reads = 0;
    const { calls, ports } = recorder({
      azureCredential: () => (++reads === 1 ? azureInput : {})
    });
    expect(await applySetupProviderConfiguration("azure", {}, ports)).toEqual({
      provider: "azure",
      credentialsComplete: false
    });
    expect(reads).toBe(2);
    expect(calls.filter(([kind]) => kind === "write")).toEqual([
      ["write", "AZURE_CLIENT_ID", "client"],
      ["write", "AZURE_TENANT_ID", "tenant"],
      ["write", "AZURE_SUBSCRIPTION_ID", "sub"],
      ["write", "AZURE_RESOURCE_GROUP", ""],
      ["write", "AZURE_AKS_CLUSTER_NAME", ""],
      ["write", "AZURE_AKS_RESOURCE_GROUP", ""],
      ["write", "AZURE_LOCATION", undefined],
      ["write", "KUBERNETES_NAMESPACE", undefined]
    ]);
    expect(calls.slice(-2)).toEqual([
      ["event", { kind: "azure-values-configured", count: 3 }],
      ["event", { kind: "credentials-missing", provider: "azure" }]
    ]);
  });

  it("retains the injected normalizer and empty-request fallback", async () => {
    const { calls, ports } = recorder({
      azureCredential: () => ({ clientId: 1, tenantId: 2, subscriptionId: 3 }),
      optionalString: (value) => `normalized-${String(value)}`
    });
    await applySetupProviderConfiguration(
      "azure",
      {
        clientId: "",
        tenantId: "",
        subscriptionId: ""
      },
      ports
    );
    expect(calls.filter(([kind]) => kind === "write").slice(0, 3)).toEqual([
      ["write", "AZURE_CLIENT_ID", "normalized-1"],
      ["write", "AZURE_TENANT_ID", "normalized-2"],
      ["write", "AZURE_SUBSCRIPTION_ID", "normalized-3"]
    ]);
  });

  it("writes whitespace unchanged and scopes role guidance to the application only", async () => {
    const { calls, ports } = recorder();
    await applySetupProviderConfiguration(
      "azure",
      {
        ...azureInput,
        clientId: " ",
        resourceGroup: "   "
      },
      ports
    );
    expect(calls).toContainEqual(["write", "AZURE_RESOURCE_GROUP", "   "]);
    expect(calls.slice(-2)).toEqual([
      ["event", { kind: "azure-values-configured", count: 8 }],
      [
        "event",
        {
          kind: "azure-role-guidance",
          assignee: " ",
          scope: "/subscriptions/sub"
        }
      ]
    ]);
  });

  it.each(["aws", "gcp", ""])(
    "keeps non-Azure %s fallback and never obtains a stored role",
    async (provider) => {
      const { calls, ports } = recorder({
        awsCredential: () => ({
          region: "ap-south-1",
          accountId: "stored-account"
        })
      });
      expect(
        await applySetupProviderConfiguration(
          provider,
          {
            roleArn: "",
            region: "",
            accountId: ""
          },
          ports
        )
      ).toEqual({ provider: "aws", credentialsComplete: false });
      expect(calls.filter(([kind]) => kind === "write")).toEqual([
        ["write", "AWS_ROLE_ARN", ""],
        ["write", "AWS_REGION", "ap-south-1"],
        ["write", "AWS_ACCOUNT_ID", "stored-account"],
        ["write", "AWS_EKS_CLUSTER_NAME", ""],
        ["write", "RADIUS_VPC_ID", undefined],
        ["write", "RADIUS_SUBNET_IDS", undefined],
        ["write", "KUBERNETES_NAMESPACE", undefined]
      ]);
      expect(calls.at(-1)).toEqual([
        "event",
        { kind: "credentials-missing", provider: "aws" }
      ]);
    }
  );

  it("uses the AWS default region after a non-string stored region", async () => {
    const { calls, ports } = recorder({ awsCredential: () => ({ region: 7 }) });
    await applySetupProviderConfiguration("aws", {}, ports);
    expect(calls).toContainEqual(["write", "AWS_REGION", "us-east-1"]);
  });

  for (const [provider, input, writes] of [
    ["azure", azureInput, azureWrites],
    ["aws", awsInput, awsWrites]
  ] as const) {
    it.each(writes.map((_, index) => index))(
      `${provider} propagates write %i failure unchanged without later writes or buffered progress`,
      async (index) => {
        const error = new Error("write outcome unknown");
        const { calls, ports } = recorder();
        let writeIndex = 0;
        ports.setEnvironmentVariable = async (name, value) => {
          calls.push(["write", name, value]);
          if (writeIndex++ === index) throw error;
          return true;
        };
        await expect(
          applySetupProviderConfiguration(provider, input, ports)
        ).rejects.toBe(error);
        expect(calls.filter(([kind]) => kind === "write")).toEqual(
          writes.slice(0, index + 1).map((write) => ["write", ...write])
        );
        expect(calls.filter(([kind]) => kind === "event")).toEqual([start]);
      }
    );
  }

  it.each([
    "azure",
    "aws",
    "readiness",
    "normalize",
    "start",
    "count",
    "guidance",
    "warning"
  ])(
    "propagates %s callback failure with its original identity",
    async (boundary) => {
      const error = new Error(boundary);
      const { calls, ports } = recorder();
      let azureReads = 0;
      ports.azureCredential = () => {
        if (
          boundary === "azure" ||
          (boundary === "readiness" && ++azureReads === 2)
        )
          throw error;
        return {};
      };
      ports.awsCredential = () => {
        if (boundary === "aws") throw error;
        return {};
      };
      ports.optionalString = () => {
        if (boundary === "normalize") throw error;
        return "";
      };
      ports.report = (event) => {
        calls.push(["event", event]);
        if (
          (boundary === "start" && event.kind === "configuration-started") ||
          (boundary === "count" && event.kind === "azure-values-configured") ||
          (boundary === "guidance" && event.kind === "azure-role-guidance") ||
          (boundary === "warning" && event.kind === "credentials-missing")
        )
          throw error;
      };
      const input =
        boundary === "normalize" || boundary === "warning" ? {} : azureInput;
      await expect(
        applySetupProviderConfiguration("azure", input, ports)
      ).rejects.toBe(error);
      if (
        ["azure", "aws", "readiness", "normalize", "start"].includes(boundary)
      ) {
        expect(calls.filter(([kind]) => kind === "write")).toEqual([]);
      }
    }
  );
});

describe("status-only provider readiness", () => {
  it.each([
    ["azure", {}, false],
    ["azure", { clientId: "c" }, false],
    ["azure", { clientId: "c", tenantId: "t" }, false],
    ["azure", { clientId: "c", tenantId: "t", subscriptionId: "s" }, true],
    ["aws", {}, false],
    ["aws", { roleArn: " " }, true],
    ["unknown", { roleArn: "role" }, true]
  ] satisfies Array<[string, SetupProviderConfigurationInput, boolean]>)(
    "%s preserves readiness and does not write or report",
    (provider, input, complete) => {
      const { calls, ports } = recorder();
      expect(setupProviderCredentialStatus(provider, input, ports)).toEqual({
        provider: provider === "azure" ? "azure" : "aws",
        credentialsComplete: complete
      });
      expect(calls.filter(([kind]) => kind === "read")).toEqual(
        provider === "azure" ? [["read", "azure"]] : []
      );
      expect(calls.some(([kind]) => kind === "write" || kind === "event")).toBe(
        false
      );
    }
  );

  it("keeps missing credential fields incomplete without cross-provider substitution", () => {
    expect(cloudCredentialsComplete("azure", { roleArn: "role" })).toBe(false);
    expect(cloudCredentialsComplete("aws", azureInput)).toBe(false);
    expect(cloudCredentialsComplete("aws", { roleArn: "" })).toBe(false);
  });

  it.each([
    [undefined, "/subscriptions/sub"],
    ["", "/subscriptions/sub"],
    ["   ", "/subscriptions/sub"],
    [" app-rg ", "/subscriptions/sub/resourceGroups/app-rg"]
  ])("uses the existing Azure role scope for %s", (group, expected) => {
    expect(azureRoleScope("sub", group)).toBe(expected);
  });
});
