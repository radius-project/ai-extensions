declare function require(name: string): unknown;

export function installRequireLoad(scope: unknown): void {
  void require(String(scope));
}
