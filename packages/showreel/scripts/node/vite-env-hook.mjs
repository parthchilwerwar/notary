const ENV = JSON.stringify({ BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: true });

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.includes("/packages/web/src/") || result.source == null) return result;
  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  if (!source.includes("import.meta.env")) return result;
  return { ...result, source: source.replaceAll("import.meta.env", `(${ENV})`) };
}
