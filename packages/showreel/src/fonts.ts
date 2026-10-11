// Notary's two typefaces from the same exact-pinned fontsource packages the web app uses
// (@fontsource/instrument-serif@5.3.0, @fontsource-variable/instrument-sans@5.3.0). The woff2
// files are bundled by Remotion's webpack (asset modules); rendering is blocked with
// delayRender until every face has loaded, so no frame is ever captured in a fallback font.
import { loadFont } from "@remotion/fonts";
import { continueRender, delayRender } from "remotion";
import serifItalic from "@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2";
import serifRegular from "@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2";
import sansItalic from "@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-italic.woff2";
import sansRegular from "@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2";

const handle = delayRender("Loading Instrument Serif and Instrument Sans");

Promise.all([
  loadFont({ family: "Instrument Serif", url: serifRegular, weight: "400", style: "normal", format: "woff2" }),
  loadFont({ family: "Instrument Serif", url: serifItalic, weight: "400", style: "italic", format: "woff2" }),
  // Variable font: one file covers 400–700.
  loadFont({ family: "Instrument Sans Variable", url: sansRegular, weight: "400 700", style: "normal", format: "woff2" }),
  loadFont({ family: "Instrument Sans Variable", url: sansItalic, weight: "400 700", style: "italic", format: "woff2" }),
])
  .then(() => document.fonts.ready)
  .then(() => continueRender(handle))
  .catch((e: unknown) => {
    // Never render in a fallback face: surface the failure and keep the render blocked (it times out).
    console.error("Font loading failed", e);
  });
