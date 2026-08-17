export function installDynamicLoad(scope: unknown): void {
  void import(String(scope));
}
