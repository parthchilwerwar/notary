// Burned-in captions from the voice's word timings: bottom-center on a dark scrim (readable over the
// sky and the white pages), at most two lines, each word brightening as it is spoken. Hidden while
// the same words are already on screen as the headline (intro, final line).
import { useCurrentFrame } from "remotion";
import { SANS } from "../theme";
import { captionsHidden } from "./plan";
import { captionPages } from "./timeline";

const PAGES = captionPages();

export function Captions() {
  const frame = useCurrentFrame();
  if (captionsHidden(frame)) return null;
  const page = PAGES.find((pg) => frame >= pg.from - 2 && frame <= pg.to);
  if (!page) return null;
  const a = Math.min(1, (frame - page.from + 3) / 4, (page.to - frame + 1) / 4);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div
        style={{
          maxWidth: 1380,
          padding: "12px 26px 14px",
          borderRadius: 16,
          background: "rgb(11 15 25 / 0.78)",
          boxShadow: "0 8px 30px rgb(11 15 25 / 0.18)",
          fontFamily: SANS,
          fontSize: 38,
          fontWeight: 500,
          lineHeight: 1.3,
          letterSpacing: "0.005em",
          color: "#FFFFFF",
          textAlign: "center",
          opacity: Math.max(0, a),
        }}
      >
        {page.words.map((w, i) => (
          <span key={i} style={{ opacity: frame >= w.from ? 1 : 0.62 }}>
            {w.text}
            {i < page.words.length - 1 ? " " : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
