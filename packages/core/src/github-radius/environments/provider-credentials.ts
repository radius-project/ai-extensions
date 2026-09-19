export function cloudCredentialsComplete(
  provider: string,
  credentials: {
    clientId?: string;
    tenantId?: string;
    subscriptionId?: string;
    roleArn?: string;
  }
): boolean {
  if (provider === "azure") {
    return !!(
      credentials.clientId &&
      credentials.tenantId &&
      credentials.subscriptionId
    );
  }
  return !!credentials.roleArn;
}
