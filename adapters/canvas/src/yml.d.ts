// radius-core imports its static workflow templates as raw text (`import x from
// "./templates/deploy.yml"`), inlined by esbuild's `text` loader at build time.
// Those .ts files are pulled into this project's type-check via the workspace
// dependency, so this project needs the same ambient declaration to resolve the
// `.yml` module imports.
declare module "*.yml" {
  const content: string;
  export default content;
}
