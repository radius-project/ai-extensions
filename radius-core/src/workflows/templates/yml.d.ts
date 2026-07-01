// Static workflow templates are shipped as .yml files and imported as raw text
// (esbuild's `text` loader inlines them into the bundle at build time). This
// ambient declaration lets `tsc` type the default import as a string.
declare module "*.yml" {
  const content: string;
  export default content;
}
