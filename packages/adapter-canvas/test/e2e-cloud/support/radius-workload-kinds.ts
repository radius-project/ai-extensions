// The Kubernetes kinds the Cloud E2E suite reads for a Radius application. A
// module of its own, so the deploy journey and the cleanup sweep share one
// list without the sweep's bundle importing the journey.

/**
 * The Kubernetes kinds Radius renders for an application.
 *
 * Presence and absence are asserted over the same set on purpose. Listing
 * fewer kinds on the delete side would let a delete that removed the Deployment
 * but stranded its Service or autoscaler report success, and cleanup already
 * reclaims all of them - so the assertion would be weaker than the sweep that
 * backs it.
 */
export const RADIUS_WORKLOAD_KINDS = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "services",
  "horizontalpodautoscalers"
] as const;

/**
 * Every labelled object a Radius application can leave on a cluster: the
 * rendered kinds, the suite's probe Jobs, the containers Recipe's
 * ServiceAccount, and the ReplicaSets and Pods controllers make from them,
 * which carry the same labels. A delete in the background removes an owner
 * before its dependents, so Pods can outlive their Deployment. Owners come
 * first, so a sweep that deletes in this order removes a ReplicaSet's
 * Deployment before the ReplicaSet and its Pods.
 */
export const RADIUS_CLEANUP_KINDS = [
  ...RADIUS_WORKLOAD_KINDS,
  "jobs",
  "serviceaccounts",
  "replicasets",
  "pods"
] as const;
