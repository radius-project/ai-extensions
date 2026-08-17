// Canvas adapter — serialization of a unit-tested Node helper into an inline
// browser script. Page renderers embed the serialized source so the shipping
// client runs the exact tested function instead of a hand-copied twin.

export function serializeBrowserFunction(
  exportName: string,
  fn: (...args: any[]) => unknown
): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw new Error(`Invalid browser function name "${exportName}".`);
  }
  return `var ${exportName} = ${fn.toString()};`;
}
