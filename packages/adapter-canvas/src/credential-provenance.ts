import {
  createCredentialProvenanceRegistry,
  type CredentialProvenanceStore,
  type RecordCredentialProvenanceInput
} from "@radius-project/core/github-radius/environments/credential-provenance";

export * from "@radius-project/core/github-radius/environments/credential-provenance";

let registry = createCredentialProvenanceRegistry(() =>
  new Date().toISOString()
);

export async function configureCredentialProvenanceStore(
  store: CredentialProvenanceStore | null
) {
  await registry.configure(store);
}
export function recordCredentialProvenance(
  input: RecordCredentialProvenanceInput
) {
  return registry.record(input);
}
export function listCredentialProvenanceForClient(clientId: string) {
  return registry.listForClient(clientId);
}
export function listCredentialProvenanceForEnvironment(
  repoId: number,
  environment: string
) {
  return registry.listForEnvironment(repoId, environment);
}
export async function removeCredentialProvenance(
  clientId: string,
  credentialId: string
) {
  await registry.removeCredential(clientId, credentialId);
}
export async function clearEnvironmentCredentialProvenance(
  repoId: number,
  environment: string
) {
  await registry.clearEnvironment(repoId, environment);
}
export function withCredentialProvenanceLock<T>(
  work: () => Promise<T>
): Promise<T> {
  return registry.withLock(work);
}
export function allCredentialProvenance() {
  return registry.all();
}
export function resetCredentialProvenanceForTest() {
  registry = createCredentialProvenanceRegistry(() => new Date().toISOString());
}
