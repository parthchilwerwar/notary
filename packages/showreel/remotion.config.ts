// For the Remotion CLI (`remotion studio`, `remotion render`): use the installed Google Chrome,
// never a downloaded headless shell, and the web app's components under `@web/…` (read-only).
// The scripts in scripts/ pass the same settings explicitly.
import { Config } from "@remotion/cli/config";
import { makeWebpackOverride } from "./src/webpack-override";

Config.setChromeMode("chrome-for-testing");
if (process.env.CHROME_PATH) Config.setBrowserExecutable(process.env.CHROME_PATH);
else if (process.platform === "win32") Config.setBrowserExecutable("C:/Program Files/Google/Chrome/Application/chrome.exe");
Config.overrideWebpackConfig(makeWebpackOverride(process.cwd()));
