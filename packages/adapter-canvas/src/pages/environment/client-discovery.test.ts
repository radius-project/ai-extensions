// Behaviour tests for the discovery fragment's refresh state and dropdown
// defaults. The fragment is a browser script string, so it is evaluated with a
// fake document that models only what these paths touch: option lists,
// selection, and the disabled state of the Refresh buttons. Anything the
// fragment reaches for that the scenario did not model is absent rather than
// silently succeeding.

import { describe, expect, it } from "vitest";
import { ENVIRONMENT_DISCOVERY_CLIENT_JS } from "./client-discovery.js";

interface FakeOption {
  value: string;
  textContent: string;
  disabled: boolean;
  selected: boolean;
}

class FakeSelect {
  value = "";
  options: FakeOption[] = [];
  set innerHTML(_value: string) {
    this.options = [];
  }
  appendChild(option: FakeOption): void {
    this.options.push(option);
  }
  insertBefore(option: FakeOption, before: FakeOption): void {
    const index = this.options.indexOf(before);
    this.options.splice(index === -1 ? this.options.length : index, 0, option);
  }
  addEventListener(): void {}
}

// The fragment wires a few page-level controls when it loads. They take no part
// in discovery, but they must exist for the script to evaluate at all.
class FakeControl {
  disabled = false;
  addEventListener(): void {}
}

// The free-text escape hatch that sits under each combo. Only its value and
// visibility matter to the restore path.
class FakeCustomInput {
  value = "";
  style = { display: "none" };
  addEventListener(): void {}
  focus(): void {}
}

interface Harness {
  discover: (provider: string) => void;
  renderAzureClusters: (list: unknown[], keep: string) => void;
  setPendingInfraSelection: (config: unknown) => void;
  currentInfraSelection: (provider: string) => Record<string, string>;
  select: (id: string) => FakeSelect;
  custom: (id: string) => FakeCustomInput;
  button: (id: string) => { disabled: boolean };
  status: (id: string) => { textContent: string };
  settle: () => Promise<void>;
  requests: number;
}

type DiscoveryResponse = Record<string, unknown>;

// Builds the fragment's world. `respond` decides what /api/discover resolves
// to; returning a rejected promise models a failed request.
function harness(respond: () => Promise<DiscoveryResponse>): Harness {
  const selects: Record<string, FakeSelect> = {};
  for (const id of [
    "azure-cluster-select",
    "azure-rg-select",
    "azure-namespace-select",
    "aws-cluster-select",
    "aws-namespace-select",
    "aws-vpc-select",
    "aws-subnets-select"
  ]) {
    selects[id] = new FakeSelect();
  }
  const buttons: Record<string, { disabled: boolean }> = {
    "azure-refresh-btn": { disabled: false },
    "aws-refresh-btn": { disabled: false }
  };
  const statuses: Record<string, { textContent: string }> = {
    "azure-discover-status": { textContent: "" },
    "aws-discover-status": { textContent: "" }
  };

  const customs: Record<string, FakeCustomInput> = {};
  for (const id of [
    "azure-cluster-custom",
    "azure-rg-custom",
    "azure-namespace-custom",
    "aws-cluster-custom",
    "aws-namespace-custom",
    "aws-vpc-custom",
    "aws-subnets-custom"
  ]) {
    customs[id] = new FakeCustomInput();
  }
  const elements: Record<string, unknown> = {
    ...selects,
    ...customs,
    ...buttons,
    ...statuses
  };
  for (const id of [
    "new-env-btn",
    "cancel-env-btn",
    "env-create-profile-link"
  ]) {
    elements[id] = new FakeControl();
  }
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (): FakeOption => ({
      value: "",
      textContent: "",
      disabled: false,
      selected: false
    })
  };

  const pending: Promise<unknown>[] = [];
  let requests = 0;
  const fetchStub = () => {
    requests += 1;
    const request = respond().then((data) => ({ json: () => data }));
    pending.push(request.catch(() => undefined));
    return request;
  };

  const api = new Function(
    "document",
    "window",
    "fetch",
    "deployBtn",
    "showEnvLanding",
    `${ENVIRONMENT_DISCOVERY_CLIENT_JS}; return { discoverResources: discoverResources, renderAzureClusters: renderAzureClusters, setPendingInfraSelection: setPendingInfraSelection, currentInfraSelection: currentInfraSelection };`
  )(document, {}, fetchStub, new FakeControl(), () => {}) as {
    discoverResources: (provider: string) => void;
    renderAzureClusters: (list: unknown[], keep: string) => void;
    setPendingInfraSelection: (config: unknown) => void;
    currentInfraSelection: (provider: string) => Record<string, string>;
  };

  return {
    discover: api.discoverResources,
    renderAzureClusters: api.renderAzureClusters,
    setPendingInfraSelection: api.setPendingInfraSelection,
    currentInfraSelection: api.currentInfraSelection,
    select: (id) => selects[id],
    custom: (id) => customs[id],
    button: (id) => buttons[id],
    status: (id) => statuses[id],
    // Discovery settles across two microtask hops (response, then json), so the
    // assertions wait on the recorded requests rather than a fixed delay.
    settle: async () => {
      await Promise.all(pending);
      await Promise.resolve();
    },
    get requests() {
      return requests;
    }
  };
}

const ok = (data: DiscoveryResponse) => () => Promise.resolve(data);

describe("discovery refresh state", () => {
  it("disables the provider's Refresh button while its request is in flight", async () => {
    const dom = harness(ok({ clusters: [], namespaces: [] }));
    dom.discover("azure");
    expect(dom.button("azure-refresh-btn").disabled).toBe(true);
    await dom.settle();
    expect(dom.button("azure-refresh-btn").disabled).toBe(false);
  });

  it("re-enables Refresh after the request fails", async () => {
    const dom = harness(() => Promise.reject(new Error("network down")));
    dom.discover("azure");
    expect(dom.button("azure-refresh-btn").disabled).toBe(true);
    await dom.settle();
    expect(dom.button("azure-refresh-btn").disabled).toBe(false);
    expect(dom.status("azure-discover-status").textContent).toContain(
      "network down"
    );
  });

  it("ignores a second request for the same provider while one is active", async () => {
    const dom = harness(ok({ clusters: [], namespaces: [] }));
    dom.discover("azure");
    dom.discover("azure");
    expect(dom.requests).toBe(1);
    await dom.settle();
    // Once settled the button is live again and a fresh request is allowed.
    dom.discover("azure");
    expect(dom.requests).toBe(2);
  });

  it("tracks each provider's request independently", async () => {
    const dom = harness(ok({ clusters: [], namespaces: [] }));
    dom.discover("azure");
    dom.discover("aws");
    expect(dom.requests).toBe(2);
    expect(dom.button("aws-refresh-btn").disabled).toBe(true);
    await dom.settle();
    expect(dom.button("azure-refresh-btn").disabled).toBe(false);
    expect(dom.button("aws-refresh-btn").disabled).toBe(false);
  });
});

describe.each([
  ["azure", "azure-cluster-select", "azure-namespace-select"],
  ["aws", "aws-cluster-select", "aws-namespace-select"]
])("%s dropdown defaults", (provider, clusterId, namespaceId) => {
  it("selects the only cluster available", async () => {
    const dom = harness(
      ok({ clusters: [{ id: "only-cluster", name: "only" }], namespaces: [] })
    );
    dom.discover(provider);
    await dom.settle();
    expect(dom.select(clusterId).value).toBe("only-cluster");
  });

  it("leaves the cluster unselected when there is a real choice", async () => {
    const dom = harness(
      ok({
        clusters: [
          { id: "a", name: "a" },
          { id: "b", name: "b" }
        ],
        namespaces: []
      })
    );
    dom.discover(provider);
    await dom.settle();
    expect(dom.select(clusterId).value).toBe("");
  });

  it("selects the default namespace when the cluster offers one", async () => {
    const dom = harness(
      ok({ clusters: [], namespaces: ["kube-system", "default", "team-a"] })
    );
    dom.discover(provider);
    await dom.settle();
    expect(dom.select(namespaceId).value).toBe("default");
  });

  it("falls back to the built-in namespaces, which include default", async () => {
    const dom = harness(ok({ clusters: [] }));
    dom.discover(provider);
    await dom.settle();
    expect(dom.select(namespaceId).value).toBe("default");
  });

  it("leaves the namespace on its placeholder when default is absent", async () => {
    const dom = harness(ok({ clusters: [], namespaces: ["team-a", "team-b"] }));
    dom.discover(provider);
    await dom.settle();
    expect(dom.select(namespaceId).value).toBe("");
  });
});

describe("azure cluster rendering", () => {
  it("keeps a still-present selection instead of auto-selecting", () => {
    const dom = harness(ok({}));
    dom.renderAzureClusters(
      [
        { id: "a", name: "a" },
        { id: "b", name: "b" }
      ],
      "b"
    );
    expect(dom.select("azure-cluster-select").value).toBe("b");
  });

  it("leaves the placeholder when the kept selection is gone from the list", () => {
    const dom = harness(ok({}));
    dom.renderAzureClusters(
      [
        { id: "a", name: "a" },
        { id: "b", name: "b" }
      ],
      "removed"
    );
    expect(dom.select("azure-cluster-select").value).toBe("");
  });

  it("auto-selects when filtering narrows the list to one cluster", () => {
    const dom = harness(ok({}));
    dom.renderAzureClusters([{ id: "only", name: "only" }], "");
    expect(dom.select("azure-cluster-select").value).toBe("only");
  });
});

describe("restoring an environment's stored infrastructure", () => {
  const azureResponse = ok({
    clusters: [
      { id: "prod-aks", name: "prod-aks", resourceGroup: "prod-rg" },
      { id: "dev-aks", name: "dev-aks", resourceGroup: "dev-rg" }
    ],
    resourceGroups: [{ id: "prod-rg", name: "prod-rg" }],
    namespaces: ["default", "payments"]
  });

  it("selects the stored values once discovery has populated the dropdowns", async () => {
    const dom = harness(azureResponse);
    dom.setPendingInfraSelection({
      resourceGroup: "prod-rg",
      cluster: "prod-aks",
      namespace: "payments"
    });
    dom.discover("azure");
    await dom.settle();
    expect(dom.select("azure-rg-select").value).toBe("prod-rg");
    expect(dom.select("azure-cluster-select").value).toBe("prod-aks");
    expect(dom.select("azure-namespace-select").value).toBe("payments");
  });

  it("falls back to the custom input when discovery no longer offers a stored value", async () => {
    const dom = harness(azureResponse);
    dom.setPendingInfraSelection({ namespace: "retired-ns" });
    dom.discover("azure");
    await dom.settle();
    expect(dom.select("azure-namespace-select").value).toBe("__custom__");
    expect(dom.custom("azure-namespace-custom").value).toBe("retired-ns");
    expect(dom.custom("azure-namespace-custom").style.display).toBe("");
  });

  it("leaves the discovery defaults alone when there is nothing to restore", async () => {
    const dom = harness(azureResponse);
    dom.setPendingInfraSelection({});
    dom.discover("azure");
    await dom.settle();
    expect(dom.select("azure-namespace-select").value).toBe("default");
    expect(dom.custom("azure-namespace-custom").style.display).toBe("none");
  });

  it("applies a restore only once, so a later refresh keeps the user's choice", async () => {
    const dom = harness(azureResponse);
    dom.setPendingInfraSelection({ namespace: "payments" });
    dom.discover("azure");
    await dom.settle();
    expect(dom.select("azure-namespace-select").value).toBe("payments");
    dom.discover("azure");
    await dom.settle();
    expect(dom.select("azure-namespace-select").value).toBe("default");
  });

  it("restores the AWS network values into their own dropdowns", async () => {
    const dom = harness(
      ok({
        clusters: [{ id: "eks-1", name: "eks-1" }],
        namespaces: ["default", "payments"],
        vpcs: [{ id: "vpc-123", name: "vpc-123" }],
        subnets: [{ id: "subnet-a", name: "subnet-a" }]
      })
    );
    dom.setPendingInfraSelection({
      cluster: "eks-1",
      namespace: "payments",
      vpcId: "vpc-123",
      subnetIds: "subnet-a"
    });
    dom.discover("aws");
    await dom.settle();
    expect(dom.select("aws-cluster-select").value).toBe("eks-1");
    expect(dom.select("aws-namespace-select").value).toBe("payments");
    expect(dom.select("aws-vpc-select").value).toBe("vpc-123");
    expect(dom.select("aws-subnets-select").value).toBe("subnet-a");
  });
});

describe("capturing what the form currently holds", () => {
  const azureResponse = ok({
    clusters: [{ id: "prod-aks", name: "prod-aks", resourceGroup: "prod-rg" }],
    resourceGroups: [{ id: "prod-rg", name: "prod-rg" }],
    namespaces: ["default", "payments"]
  });

  it("reads the selected values back in the shape a restore expects", async () => {
    const dom = harness(azureResponse);
    dom.setPendingInfraSelection({
      resourceGroup: "prod-rg",
      cluster: "prod-aks",
      namespace: "payments"
    });
    dom.discover("azure");
    await dom.settle();
    expect(dom.currentInfraSelection("azure")).toEqual({
      resourceGroup: "prod-rg",
      cluster: "prod-aks",
      namespace: "payments"
    });
  });

  it("reads a hand-typed value from the custom input rather than the combo", async () => {
    const dom = harness(azureResponse);
    dom.setPendingInfraSelection({ namespace: "retired-ns" });
    dom.discover("azure");
    await dom.settle();
    expect(dom.currentInfraSelection("azure").namespace).toBe("retired-ns");
  });

  it("captures the AWS network fields for an AWS profile", async () => {
    const dom = harness(
      ok({
        clusters: [{ id: "eks-1", name: "eks-1" }],
        namespaces: ["default"],
        vpcs: [{ id: "vpc-123", name: "vpc-123" }],
        subnets: [{ id: "subnet-a", name: "subnet-a" }]
      })
    );
    dom.setPendingInfraSelection({ vpcId: "vpc-123", subnetIds: "subnet-a" });
    dom.discover("aws");
    await dom.settle();
    const captured = dom.currentInfraSelection("aws");
    expect(captured.vpcId).toBe("vpc-123");
    expect(captured.subnetIds).toBe("subnet-a");
    expect(captured).not.toHaveProperty("resourceGroup");
  });
});
