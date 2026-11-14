import { describe, expect, it } from "vitest";
import { FakeKubernetes } from "./fake-kubernetes.js";

const LABELS = {
  "radapp.io/environment": "env",
  "radapp.io/application": "app"
};

describe("FakeKubernetes", () => {
  it("lists only labelled workloads, as the selector does", () => {
    const kube = new FakeKubernetes();
    kube.addWorkload("c", {
      kind: "Deployment",
      name: "web",
      namespace: "ns",
      labels: LABELS,
      creationTimestamp: "2026-01-01T00:00:00Z"
    });
    kube.addWorkload("c", {
      kind: "Deployment",
      name: "other",
      namespace: "ns",
      labels: {},
      creationTimestamp: "2026-01-01T00:00:00Z"
    });
    expect(kube.list("c")).toEqual({
      kind: "List",
      items: [
        {
          kind: "Deployment",
          metadata: {
            name: "web",
            namespace: "ns",
            labels: LABELS,
            creationTimestamp: "2026-01-01T00:00:00Z"
          }
        }
      ]
    });
  });

  it("deletes one workload by kind in any case, and a namespace with its workloads", () => {
    const kube = new FakeKubernetes();
    for (const name of ["a", "b"])
      kube.addWorkload("c", {
        kind: "Deployment",
        name,
        namespace: name === "a" ? "one" : "two",
        labels: LABELS,
        creationTimestamp: ""
      });
    kube.delete("c", "deployment", "a", "one");
    expect(kube.snapshot()).toEqual(["c Deployment two/b"]);
    expect(kube.namespaceExists("c", "two")).toBe(true);
    kube.deleteNamespace("c", "two");
    expect(kube.namespaceExists("c", "two")).toBe(false);
    expect(kube.snapshot()).toEqual([]);
    kube.addNamespace("d", "x");
    expect(kube.namespaceExists("d", "x")).toBe(true);
  });
});
