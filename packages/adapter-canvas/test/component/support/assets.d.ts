// Vite serves the library stylesheet as a side-effect import; TypeScript needs
// the module shape declared because the repository compiles without a bundler
// asset plugin.
declare module "*.css";
