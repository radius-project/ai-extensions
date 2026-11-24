import { describe, expect, it } from "vitest";
import { FakeKubernetes } from "./fake-kubernetes.js";

const KINDS = ["deployments", "jobs"];

const LABELS = {
  "radapp.io/environment": "env",
  "radapp.io/application": "app"
};

describe("FakeKubernetes", () => {
  it("lists only labelled workloads, as the selector does", () => {
    const kube = new FakeKubernetes();
    kube.addCluster("c");
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
    expect(kube.list("c", KINDS)).toEqual({
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

  it("deletes one workload by kind in any case, and a namespace with its workloads, each after it terminates", () => {
    const kube = new FakeKubernetes();
    kube.addCluster("c");
    kube.addCluster("d");
    for (const name of ["a", "b"])
      kube.addWorkload("c", {
        kind: "Deployment",
        name,
        namespace: name === "a" ? "one" : "two",
        labels: LABELS,
        creationTimestamp: ""
      });
    kube.delete("c", "deployment", "a", "one");
    // Still listed while it terminates, with a deletionTimestamp.
    const listed = (key: string) =>
      (
        kube.list(key, KINDS) as {
          items: Array<{
            metadata: { name: string; deletionTimestamp?: string };
          }>;
        }
      ).items.map((item) => [
        item.metadata.name,
        item.metadata.deletionTimestamp !== undefined
      ]);
    expect(listed("c")).toEqual([
      ["a", true],
      ["b", false]
    ]);
    // A second delete of a terminating workload doesn't restart it.
    kube.delete("c", "Deployment", "a", "one");
    expect(listed("c")).toEqual([
      ["a", true],
      ["b", false]
    ]);
    expect(listed("c")).toEqual([["b", false]]);
    expect(kube.snapshot()).toEqual(["c Deployment two/b"]);

    kube.deleteNamespace("c", "two");
    expect(kube.namespaceExists("c", "two")).toBe(true);
    expect(() =>
      kube.addWorkload("c", {
        kind: "Job",
        name: "late",
        namespace: "two",
        labels: LABELS,
        creationTimestamp: ""
      })
    ).toThrow("namespace two is being terminated");
    expect(kube.namespaceExists("c", "two")).toBe(true);
    expect(kube.namespaceExists("c", "two")).toBe(false);
    expect(kube.snapshot()).toEqual([]);
    kube.deleteNamespace("c", "two");
    expect(kube.namespaceExists("c", "two")).toBe(false);
    kube.addNamespace("d", "x");
    expect(kube.namespaceExists("d", "x")).toBe(true);
  });

  it("finishes every delete at once when it settles, and at once with no terminating reads", () => {
    const kube = new FakeKubernetes();
    kube.addCluster("c");
    kube.addWorkload("c", {
      kind: "Deployment",
      name: "a",
      namespace: "one",
      labels: LABELS,
      creationTimestamp: ""
    });
    kube.addNamespace("c", "two");
    kube.delete("c", "Deployment", "a", "one");
    kube.deleteNamespace("c", "two");
    kube.settle();
    expect(kube.snapshot()).toEqual([]);
    expect(kube.namespaceExists("c", "two")).toBe(false);

    kube.terminatingReads = 0;
    kube.deleteNamespace("c", "one");
    expect(kube.namespaceExists("c", "one")).toBe(false);
  });

  it("lists only the resource types asked for, in that order, and refuses one it doesn't know", () => {
    const kube = new FakeKubernetes();
    kube.addCluster("c");
    for (const [kind, name] of [
      ["Pod", "p"],
      ["Job", "j"],
      ["Deployment", "d"]
    ] as const)
      kube.addWorkload("c", {
        kind,
        name,
        namespace: "ns",
        labels: LABELS,
        creationTimestamp: ""
      });
    const kinds = (resources: string[]) =>
      (
        kube.list("c", resources) as { items: Array<{ kind: string }> }
      ).items.map((item) => item.kind);
    expect(kinds(["deployments", "jobs"])).toEqual(["Deployment", "Job"]);
    expect(kinds(["pods", "deployments"])).toEqual(["Pod", "Deployment"]);
    expect(() => kube.list("c", ["deployment"])).toThrow(
      'error: the server doesn\'t have a resource type "deployment"'
    );
  });

  describe("deleting an owner", () => {
    function chain() {
      const kube = new FakeKubernetes();
      kube.addCluster("c");
      const add = (
        kind: string,
        name: string,
        owner?: { kind: string; name: string }
      ) =>
        kube.addWorkload("c", {
          kind,
          name,
          namespace: "ns",
          labels: LABELS,
          creationTimestamp: "",
          ...(owner ? { owner } : {})
        });
      add("Deployment", "web");
      add("ReplicaSet", "web-1", { kind: "Deployment", name: "web" });
      add("Pod", "web-1-a", { kind: "ReplicaSet", name: "web-1" });
      // Another Deployment's Pod, and one in another namespace, stay.
      add("Pod", "other", { kind: "ReplicaSet", name: "other" });
      return kube;
    }
    const names = (kube: FakeKubernetes) =>
      (
        kube.list("c", ["deployments", "replicasets", "pods"]) as {
          items: Array<{ metadata: { name: string } }>;
        }
      ).items.map((item) => item.metadata.name);

    it("in the background removes the owner first and leaves its dependents a while", () => {
      const kube = chain();
      kube.terminatingReads = 1;
      kube.dependentLagReads = 2;
      kube.delete("c", "Deployment", "web", "ns");
      expect(names(kube)).toEqual(["web", "web-1", "web-1-a", "other"]);
      expect(names(kube)).toEqual(["web-1", "web-1-a", "other"]);
      expect(names(kube)).toEqual(["web-1", "web-1-a", "other"]);
      expect(names(kube)).toEqual(["other"]);
    });

    it("in the foreground keeps the owner listed until its dependents are gone", () => {
      const kube = chain();
      kube.terminatingReads = 1;
      kube.dependentLagReads = 5;
      kube.delete("c", "Deployment", "web", "ns", "foreground");
      expect(names(kube)).toEqual(["web", "web-1", "web-1-a", "other"]);
      expect(names(kube)).toEqual(["other"]);
    });

    it("doesn't restart a dependent already going, and ignores one it can't find", () => {
      const kube = chain();
      kube.terminatingReads = 1;
      kube.dependentLagReads = 3;
      kube.delete("c", "Pod", "web-1-a", "ns");
      kube.delete("c", "Deployment", "web", "ns");
      kube.delete("c", "Deployment", "gone", "ns");
      expect(names(kube)).toEqual(["web", "web-1", "web-1-a", "other"]);
      expect(names(kube)).toEqual(["web-1", "other"]);
    });
  });

  it("refuses a cluster it wasn't given, so a mistyped target can't pass", () => {
    const kube = new FakeKubernetes();
    kube.addCluster("us-east-2/main");
    const workload = {
      kind: "Deployment",
      name: "web",
      namespace: "ns",
      labels: LABELS,
      creationTimestamp: ""
    };
    kube.addWorkload("us-east-2/main", workload);
    const typo = "us-east-2/mian";
    for (const call of [
      () => kube.list(typo, KINDS),
      () => kube.objects(typo),
      () => kube.delete(typo, "Deployment", "web", "ns"),
      () => kube.namespaceExists(typo, "ns"),
      () => kube.deleteNamespace(typo, "ns"),
      () => kube.addWorkload(typo, workload),
      () => kube.addNamespace(typo, "ns")
    ])
      expect(call).toThrow(`The fake has no cluster ${typo}.`);
    expect(kube.snapshot()).toEqual(["us-east-2/main Deployment ns/web"]);
    expect(kube.namespaceExists("us-east-2/main", "default")).toBe(true);
    expect(() => kube.addCluster("us-east-2/main")).toThrow(
      "The fake already has cluster us-east-2/main."
    );
  });
});
