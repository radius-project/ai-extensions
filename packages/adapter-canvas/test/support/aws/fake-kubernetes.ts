// A stand-in for the Kubernetes reads and deletes the Cloud E2E cleanup
// sweep makes on each cluster: Radius-rendered workloads, listed as
// `kubectl get -o json` lists them, and namespaces. Deleting a namespace
// deletes the workloads in it, as the namespace controller does. A test adds
// each cluster first, and any call to a cluster it didn't add throws, as
// kubectl fails for a cluster it can't reach.
//
// Deletes finish late, as Kubernetes's graceful deletion does: a deleted
// workload is still listed, with a deletionTimestamp, and a deleted namespace
// still exists, while it terminates. Each read moves it one step closer to
// gone. How long finalizers take isn't documented, so the fake takes
// `terminatingReads` reads, and `settle()` ends every delete, as a day does.
// https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/
// https://kubernetes.io/docs/tasks/administer-cluster/namespaces/#deleting-a-namespace
//
// An object can name its owner, as a ReplicaSet names its Deployment and a
// Pod its ReplicaSet. Deleting an owner deletes its dependents, as the
// garbage collector does. In the background, kubectl's default, the owner
// goes first and its dependents outlive it. In the foreground, the owner
// stays listed until its dependents are gone. How long the collector takes
// isn't documented, so dependents of a background delete take
// `dependentLagReads` more reads.
// https://kubernetes.io/docs/concepts/architecture/garbage-collection/#cascading-deletion
//
// A list names its resource types, as `kubectl get` does, and only those
// kinds are returned, grouped in that order. A type the fake doesn't know is
// refused, as the API server refuses one it doesn't serve.

export interface FakeWorkload {
  kind: string;
  name: string;
  namespace: string;
  labels: Record<string, string>;
  creationTimestamp: string;
  // The owner in the same namespace, as its ownerReferences name it.
  owner?: { kind: string; name: string };
}

// `kubectl get` resource types and the kind each lists.
const RESOURCE_KINDS: Readonly<Record<string, string>> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
  services: "Service",
  horizontalpodautoscalers: "HorizontalPodAutoscaler",
  jobs: "Job",
  serviceaccounts: "ServiceAccount",
  replicasets: "ReplicaSet",
  pods: "Pod"
};

export type FakePropagation = "background" | "foreground";

export interface StoredWorkload extends FakeWorkload {
  // Reads left before a deleted workload is gone; undefined until deleted.
  terminating?: number;
}

interface FakeCluster {
  workloads: StoredWorkload[];
  namespaces: Set<string>;
  // Reads left before each deleted namespace is gone.
  terminatingNamespaces: Map<string, number>;
}

export class FakeKubernetes {
  readonly clusters = new Map<string, FakeCluster>();
  // How many reads a delete takes to finish.
  terminatingReads = 2;
  // How many more reads the dependents of a background delete take.
  dependentLagReads = 2;

  addCluster(key: string): void {
    if (this.clusters.has(key))
      throw new Error(`The fake already has cluster ${key}.`);
    this.clusters.set(key, {
      workloads: [],
      namespaces: new Set(["default"]),
      terminatingNamespaces: new Map()
    });
  }

  private cluster(key: string): FakeCluster {
    const cluster = this.clusters.get(key);
    if (!cluster) throw new Error(`The fake has no cluster ${key}.`);
    return cluster;
  }

  addWorkload(key: string, workload: FakeWorkload): void {
    const cluster = this.cluster(key);
    if (cluster.terminatingNamespaces.has(workload.namespace))
      throw new Error(
        `namespace ${workload.namespace} is being terminated, so nothing can be created in it.`
      );
    cluster.namespaces.add(workload.namespace);
    cluster.workloads.push({
      ...workload,
      labels: { ...workload.labels },
      ...(workload.owner ? { owner: { ...workload.owner } } : {})
    });
  }

  addNamespace(key: string, namespace: string): void {
    this.cluster(key).namespaces.add(namespace);
  }

  /**
   * What `kubectl get <resources> --selector radapp.io/environment -o json`
   * prints.
   */
  list(key: string, resources: readonly string[]): unknown {
    const kinds = resources.map((resource) => {
      const kind = RESOURCE_KINDS[resource];
      if (!kind)
        throw new Error(
          `error: the server doesn't have a resource type "${resource}"`
        );
      return kind;
    });
    const cluster = this.cluster(key);
    this.advance(cluster);
    return {
      kind: "List",
      items: kinds
        .flatMap((kind) =>
          cluster.workloads.filter(
            (item) =>
              item.kind === kind && "radapp.io/environment" in item.labels
          )
        )
        .map((item) => ({
          kind: item.kind,
          metadata: {
            name: item.name,
            namespace: item.namespace,
            labels: { ...item.labels },
            creationTimestamp: item.creationTimestamp,
            ...(item.terminating === undefined ?
              {}
            : { deletionTimestamp: "2026-11-01T00:00:00Z" })
          }
        }))
    };
  }

  /** `kubectl delete <kind>/<name> --cascade=<propagation>`. */
  delete(
    key: string,
    kind: string,
    name: string,
    namespace: string,
    propagation: FakePropagation = "background"
  ): void {
    const cluster = this.cluster(key);
    const target = cluster.workloads.find(
      (item) =>
        item.kind.toLowerCase() === kind.toLowerCase() &&
        item.name === name &&
        item.namespace === namespace
    );
    if (!target) return;
    const lag =
      propagation === "background" ?
        this.terminatingReads + this.dependentLagReads
      : this.terminatingReads;
    // A foreground delete keeps the owner until its dependents are gone.
    const last = Math.max(
      this.terminatingReads,
      ...this.dependents(cluster, target).map(
        (item) => (item.terminating ??= lag)
      )
    );
    target.terminating ??=
      propagation === "foreground" ? last : this.terminatingReads;
  }

  // Everything that names `owner` as its owner, and their dependents.
  private dependents(
    cluster: FakeCluster,
    owner: StoredWorkload
  ): StoredWorkload[] {
    const direct = cluster.workloads.filter(
      (item) =>
        item.namespace === owner.namespace &&
        item.owner?.kind === owner.kind &&
        item.owner.name === owner.name
    );
    return direct.flatMap((item) => [item, ...this.dependents(cluster, item)]);
  }

  namespaceExists(key: string, namespace: string): boolean {
    const cluster = this.cluster(key);
    this.advance(cluster);
    return cluster.namespaces.has(namespace);
  }

  deleteNamespace(key: string, namespace: string): void {
    const cluster = this.cluster(key);
    if (!cluster.namespaces.has(namespace)) return;
    if (!cluster.terminatingNamespaces.has(namespace))
      cluster.terminatingNamespaces.set(namespace, this.terminatingReads);
    for (const item of cluster.workloads)
      if (item.namespace === namespace)
        item.terminating ??= this.terminatingReads;
  }

  /** Finish every delete, as Kubernetes has a day later. */
  settle(): void {
    for (const cluster of this.clusters.values()) {
      for (const item of cluster.workloads)
        if (item.terminating !== undefined) item.terminating = 0;
      for (const namespace of cluster.terminatingNamespaces.keys())
        cluster.terminatingNamespaces.set(namespace, 0);
      this.advance(cluster);
    }
  }

  // Each read moves every delete one step closer to gone.
  private advance(cluster: FakeCluster): void {
    cluster.workloads = cluster.workloads.filter((item) => {
      if (item.terminating === undefined) return true;
      if (item.terminating <= 0) return false;
      item.terminating -= 1;
      return true;
    });
    for (const [namespace, reads] of cluster.terminatingNamespaces) {
      if (reads > 0) {
        cluster.terminatingNamespaces.set(namespace, reads - 1);
        continue;
      }
      cluster.terminatingNamespaces.delete(namespace);
      cluster.namespaces.delete(namespace);
    }
  }

  /** A cluster's objects, whatever their labels, including deleted ones. */
  objects(key: string): readonly Readonly<StoredWorkload>[] {
    return this.cluster(key).workloads;
  }

  /** Every workload, as `cluster kind namespace/name`, in a stable order. */
  snapshot(): string[] {
    return [...this.clusters]
      .flatMap(([key, cluster]) =>
        cluster.workloads.map(
          (item) => `${key} ${item.kind} ${item.namespace}/${item.name}`
        )
      )
      .sort();
  }
}
