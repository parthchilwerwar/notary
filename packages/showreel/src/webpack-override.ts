// Webpack settings shared by the Remotion CLI (remotion.config.ts) and the render scripts: the web
// app's own components and styles are imported read-only from packages/web/src under `@web/…` (react,
// react-router and zod resolve to the same pnpm instances the web app uses), with Vite's
// import.meta.env filled in.
import { join, resolve } from "node:path";
import type { WebpackOverrideFn } from "@remotion/bundler";

export function makeWebpackOverride(packageRoot: string): WebpackOverrideFn {
  const webRoot = resolve(packageRoot, "../web");
  const webSrc = join(webRoot, "src");
  const loader = join(packageRoot, "scripts/node/vite-env-loader.cjs");
  return (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      // packages/core imports its own modules with NodeNext ".js" specifiers.
      extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
      alias: {
        ...(config.resolve?.alias as Record<string, string> | undefined),
        "@web": webSrc,
      },
    },
    module: {
      ...config.module,
      rules: [
        // Remotion's esbuild-loader defines import.meta.env as {NODE_ENV}, which breaks the web's
        // `() => import.meta.env` arrow; this pre-loader substitutes a parenthesized object first.
        { test: /packages[\\/]web[\\/]src[\\/].+\.tsx?$/, enforce: "pre" as const, use: [{ loader }] },
        ...(config.module?.rules ?? []),
      ],
    },
  });
}
