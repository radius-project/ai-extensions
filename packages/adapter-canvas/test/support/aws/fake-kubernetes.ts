// A stand-in for the Kubernetes reads and deletes the Cloud E2E cleanup
// sweep makes on each cluster: Radius-rendered workloads, listed as
// `kubectl get -o json` lists them, and namespaces. Deleting a namespace
// deletes the workloads in it, as the namespace controller does. A test adds
// each cluster first, and any call to a cluster it didn't add throws, as
// kubectl fails for a cluster it can't reach.

export interface FakeWorkload {
  kind: string;
  name: string;
  namespace: string;
  labels: Record<string, string>;
  creationTimestamp: string;
}

interface FakeCluster {
  workloads: FakeWorkload[];
  namespaces: Set<string>;
}

export class FakeKubernetes {
  readonly clusters = new Map<string, FakeCluster>();

  addCluster(key: string): void {
    if (this.clusters.has(key))
      throw new Error(`The fake already has cluster ${key}.`);
    this.clusters.set(key, { workloads: [], namespaces: new Set(["default"]) });
  }

  private cluster(key: string): FakeCluster {
    const cluster = this.clusters.get(key);
    if (!cluster) throw new Error(`The fake has no cluster ${key}.`);
    return cluster;
  }

  addWorkload(key: string, workload: FakeWorkload): void {
    const cluster = this.cluster(key);
    cluster.namespaces.add(workload.namespace);
    cluster.workloads.push({ ...workload, labels: { ...workload.labels } });
  }

  addNamespace(key: string, namespace: string): void {
    this.cluster(key).namespaces.add(namespace);
  }

  /** What `kubectl get ... --selector radapp.io/environment -o json` prints. */
  list(key: string): unknown {
    return {
      kind: "List",
      items: this.cluster(key)
        .workloads.filter((item) => "radapp.io/environment" in item.labels)
        .map((item) => ({
          kind: item.kind,
          metadata: {
            name: item.name,
            namespace: item.namespace,
            labels: { ...item.labels },
            creationTimestamp: item.creationTimestamp
          }
        }))
    };
  }

  delete(key: string, kind: string, name: string, namespace: string): void {
    const cluster = this.cluster(key);
    cluster.workloads = cluster.workloads.filter(
      (item) =>
        !(
          item.kind.toLowerCase() === kind.toLowerCase() &&
          item.name === name &&
          item.namespace === namespace
        )
    );
  }

  namespaceExists(key: string, namespace: string): boolean {
    return this.cluster(key).namespaces.has(namespace);
  }

  deleteNamespace(key: string, namespace: string): void {
    const cluster = this.cluster(key);
    cluster.namespaces.delete(namespace);
    cluster.workloads = cluster.workloads.filter(
      (item) => item.namespace !== namespace
    );
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
