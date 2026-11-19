export function isNonFileExtensionReference(reference: string): boolean {
  return /^(br|oci|builtin):/i.test(reference);
}
