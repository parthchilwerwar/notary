// Font files are bundled by Remotion's webpack config (asset modules) and imported as URLs.
declare module "*.woff2" {
  const url: string;
  export default url;
}

// scripts/props.ts reuses the web data layer, which reads Vite's import.meta.env lazily (only when
// no base URL is passed, which props.ts always does). Declared here so tsc can check those files.
interface ImportMetaEnv {
  readonly [key: string]: unknown;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
