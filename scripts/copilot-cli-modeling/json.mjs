// Checks for the JSON that the run reads from the plugin build and the agent
// runtime. The run reads only a few fields of each document, so it checks
// each field where it reads it.

/** Parses JSON text, or returns `undefined` when the text is not JSON. */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `object[key]` is a string. */
export function hasText(object, key) {
  return typeof object[key] === "string";
}
