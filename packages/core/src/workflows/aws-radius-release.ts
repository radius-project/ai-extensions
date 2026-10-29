// The Radius build AWS workflows install unless the environment sets
// RADIUS_RELEASE_OVERRIDE. No Radius release has the fix that keeps request
// secrets such as an RDS MasterUserPassword out of AWS responses
// (radius-project/radius#13465, merged as 0e23c089) or the aws-eks catalog
// entry (radius-project/radius#13542, merged as 15ca204a), so AWS uses edge
// while Azure and the shared setup-control-plane default stay on the release.
//
// Edge floats with Radius main. The commit pins only the installer, by its
// checksum, and the contrib catalog; the CLI and control-plane images are
// whatever edge is when the workflow runs. #1130 replaces this with the first
// Radius release that has both commits before AWS is turned on for users.
export const AWS_RADIUS_RELEASE = {
  tag: "edge",
  commit: "15ca204ae62238ba6469a7adfaef44cd411a3159",
  checksum: "483ed038411c8550ef20a0ad06edfe79b41ae73f321d59f88fb06c67dbdb730f"
} as const;

// The single-line JSON the AWS workflow templates use as their
// RADIUS_RELEASE_OVERRIDE default.
export const AWS_RADIUS_RELEASE_OVERRIDE = JSON.stringify(AWS_RADIUS_RELEASE);
