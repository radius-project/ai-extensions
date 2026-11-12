// Construction-time dependency validation shared by the deploy services.
//
// The composition root builds one complete dependency object and hands each
// service a narrowed view of it. A view that is missing a seam must fail while
// the server module is being initialised — never at request time, and never by
// installing a silent success-shaped default — so every deploy service runs
// this over its own required list before returning.
export function assertDeployDependencies<T extends object>(
  serviceName: string,
  dependencies: T,
  required: readonly (keyof T)[]
): void {
  const missing = required.filter(
    (name) => typeof dependencies[name] !== "function"
  );
  if (missing.length > 0) {
    throw new Error(
      `${serviceName} is missing required dependencies: ${missing.join(", ")}`
    );
  }
}
