const KUBERNETES_NAMESPACE_MAX_LENGTH = 63;
export const KUBERNETES_NAMESPACE_PATTERN = "[a-z0-9](?:[-a-z0-9]*[a-z0-9])?";
const KUBERNETES_NAMESPACE_REGEX = new RegExp(
  `^${KUBERNETES_NAMESPACE_PATTERN}$`,
  "u"
);

export const KUBERNETES_NAMESPACE_ERROR =
  "Kubernetes namespace must be 1-63 lowercase letters, numbers, or hyphens and must start and end with a letter or number.";

export function isKubernetesNamespace(value: string): boolean {
  return (
    value.length <= KUBERNETES_NAMESPACE_MAX_LENGTH &&
    KUBERNETES_NAMESPACE_REGEX.test(value)
  );
}
