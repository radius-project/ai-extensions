import { awsConsoleUrl } from "../domain/aws-console.js";
import type { ComputePlatform } from "./types.js";

export const aws: ComputePlatform = {
  id: "aws",
  displayName: "AWS",
  clusterServiceName: "EKS",

  // An AWS resource ID names its own region, so the link comes from the ID
  // alone, through the same mapping the graph uses. A bare type, or an ID the
  // canvas does not recognize, gets no link rather than a guessed region.
  portalUrl(resourceId: string): string {
    return awsConsoleUrl(resourceId);
  }
};
