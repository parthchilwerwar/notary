// webpack loader (pre): the web app's modules read Vite's `import.meta.env`; in the Remotion bundle
// they get the values a production build of the web app would see. Applied only to packages/web/src.
const ENV = JSON.stringify({ BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: false });
module.exports = function viteEnvLoader(source) {
  return source.includes("import.meta.env") ? source.split("import.meta.env").join(`(${ENV})`) : source;
};
