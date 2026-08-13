const sdkStubUrl = new URL("./sdk-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@github/copilot-sdk" ||
    specifier === "@github/copilot-sdk/extension"
  ) {
    return { url: sdkStubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
