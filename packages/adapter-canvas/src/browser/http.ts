import { readString } from "./json.js";
import type { HttpResponse } from "./ports.js";

export class ServerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerResponseError";
  }
}

export async function requireSuccessfulJsonResponse(
  response: HttpResponse,
  fallbackMessage: string
): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ServerResponseError(fallbackMessage);
  }
  const serverMessage = readString(payload, "error");
  if (!response.ok || serverMessage !== "") {
    throw new ServerResponseError(serverMessage || fallbackMessage);
  }
  return payload;
}
