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

export interface FakeWorkload {
  kind: string;
  name: string;
  namespace: string;
  labels: Record<string, string>;
  creationTimestamp: string;
}

interface StoredWorkload extends FakeWorkload {
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
    cluster.workloads.push({ ...workload, labels: { ...workload.labels } });
  }

  addNamespace(key: string, namespace: string): void {
    this.cluster(key).namespaces.add(namespace);
  }

  /** What `kubectl get ... --selector radapp.io/environment -o json` prints. */
  list(key: string): unknown {
    const cluster = this.cluster(key);
    this.advance(cluster);
    return {
      kind: "List",
      items: cluster.workloads
        .filter((item) => "radapp.io/environment" in item.labels)
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

  delete(key: string, kind: string, name: string, namespace: string): void {
    for (const item of this.cluster(key).workloads)
      if (
        item.kind.toLowerCase() === kind.toLowerCase() &&
        item.name === name &&
        item.namespace === namespace
      )
        item.terminating ??= this.terminatingReads;
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
