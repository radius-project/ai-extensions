import { readArray, readRecord, readString } from "./json.js";

/**
 * Resources named in a delete confirmation must provably belong to the pair
 * being deleted. A deployed-graph response can carry a graph resolved from a
 * different application's artifact, so the inventory's own identity is checked
 * rather than trusting that the response answers the request that was sent.
 *
 * Fails closed: anything unverified yields an empty list, which the dialog
 * renders as its generic warning instead of naming resources.
 */
export function deletionInventoryResources(
  payload: unknown,
  application: string,
  environment: string
): readonly unknown[] {
  const inventory = readRecord(payload, "deletionInventory");
  const mode = readString(payload, "mode") || "greyed";
  if (
    mode === "greyed" ||
    application === "" ||
    environment === "" ||
    readString(inventory, "application").toLowerCase() !==
      application.toLowerCase() ||
    readString(inventory, "environment").toLowerCase() !==
      environment.toLowerCase()
  ) {
    return [];
  }
  return readArray(inventory, "resources");
}
