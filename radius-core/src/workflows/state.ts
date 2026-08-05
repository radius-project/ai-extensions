const GHCR_HOST = "ghcr.io";
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_SLUG_LENGTH = 100;
const MAX_ENVIRONMENT_SLUG_LENGTH = 80;

export const OCI_STATE_BACKEND = "oci";
export const DEFAULT_STATE_ARCHIVE = "radius-state";

function slug(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function registrySuffix(value: string): string {
  return `${hash32(value, 0x811c9dc5)}${hash32(value, 0x9e3779b9).slice(0, 4)}`;
}

/**
 * Returns the untagged GHCR repository used to persist Radius control-plane
 * state for one GitHub Environment.
 */
export function stateRegistryForEnvironment(
  targetRepository: string,
  environment: string
): string {
  const repositoryParts = targetRepository.trim().split("/");
  if (
    repositoryParts.length !== 2 ||
    repositoryParts.some((part) => !part.trim())
  ) {
    throw new Error(
      `Invalid repository "${targetRepository}": expected owner/repo.`
    );
  }

  const environmentName = environment.trim();
  if (!environmentName) {
    throw new Error("Environment name is required to configure state storage.");
  }

  const owner = slug(repositoryParts[0], MAX_OWNER_LENGTH);
  const repository = slug(repositoryParts[1], MAX_REPOSITORY_SLUG_LENGTH);
  const environmentSlug = slug(environmentName, MAX_ENVIRONMENT_SLUG_LENGTH);
  if (!owner || !repository || !environmentSlug) {
    throw new Error(
      "Repository and environment names must contain an ASCII letter or number to configure GHCR state storage."
    );
  }

  const identity =
    `${repositoryParts[0].toLowerCase()}/${repositoryParts[1].toLowerCase()}` +
    `\0${environmentName.toLowerCase()}`;
  const packageName = `${repository}-radius-state-${environmentSlug}-${registrySuffix(identity)}`;

  return `${GHCR_HOST}/${owner}/${packageName}`;
}
