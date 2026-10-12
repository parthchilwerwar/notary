import { lazy, Suspense, useRef } from "react";
import type { DataSource } from "../../data";
import { GridSection } from "../brand/GridFrame";
import { drawStrokes, revealTitle } from "./motion";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { useNear } from "./useNear";

const ChatShowcase = lazy(() => import("./ChatShowcase"));

// Chip anchors on the 1120 × 520 desktop stage (decorative layout, no data). The chat window
// spans x 280–840; each dashed connector runs from a chip to the window's edge.
const STAGE = { w: 1120, h: 520, left: 280, right: 840 } as const;
const CHIP_Y = [92, 260, 428] as const;
const WINDOW_Y = [150, 260, 370] as const;

function connector(side: "l" | "r", i: number) {
  const y0 = CHIP_Y[i]!;
  const y1 = WINDOW_Y[i]!;
  if (side === "l") return `M 212 ${y0} C 248 ${y0}, 244 ${y1}, ${STAGE.left - 8} ${y1}`;
  return `M ${STAGE.right + 8} ${y1} C ${STAGE.right + 36} ${y1}, ${STAGE.w - 248} ${y0}, ${STAGE.w - 212} ${y0}`;
}

/**
 * `chips`: the integrations evidence/evidence.json confirms (landing-data `builtWith`), at most
 * three per side; a pending one (cfo.ai before a plan is imported) is never a chip. Wires are drawn
 * only to chips that exist.
 */
export function ChatSection({ source, chips }: { source: DataSource; chips: readonly string[] }) {
  const root = useRef<HTMLElement>(null);
  const near = useNear(root);
  const left = chips.slice(0, 3);
  const right = chips.slice(3, 6);
  const sides = [
    ["l", left],
    ["r", right],
  ] as const;

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        revealTitle(root.current!.querySelector(".l-h2"));
        drawStrokes(gsap.utils.toArray<SVGGeometryElement>(".l-draw", root.current), root.current!.querySelector(".l-chat-stage"), 1.1);
      });
    },
    { scope: root },
  );

  return (
    <GridSection ref={root} id="chat" className="l-section l-chat-section" aria-labelledby="chat-title" rule>
      <div className="grid-inner">
        <header className="l-section-head l-center">
          <p className="section-label">Notary Chat</p>
          <h2 id="chat-title" className="display l-h2">
            Ask why. Get the records.
          </h2>
          <p className="l-lede">
            Every step is a real lookup over your runs, certificates and held actions, and every answer cites the
            records it came from.
          </p>
        </header>
        <div className="l-chat-stage">
          <svg className="l-chat-wires" viewBox={`0 0 ${STAGE.w} ${STAGE.h}`} aria-hidden="true" focusable="false">
            <defs>
              {sides.flatMap(([side, names]) =>
                names.map((_, i) => (
                  <mask key={`${side}${i}`} id={`chat-wire-${side}${i}`} maskUnits="userSpaceOnUse">
                    <path className="l-draw" d={connector(side, i)} fill="none" stroke="#fff" strokeWidth="6" />
                  </mask>
                )),
              )}
            </defs>
            {sides.flatMap(([side, names]) =>
              names.map((_, i) => (
                <g key={`${side}${i}`}>
                  <path className="l-wire" d={connector(side, i)} mask={`url(#chat-wire-${side}${i})`} />
                  <circle className="l-wire-node" cx={side === "l" ? STAGE.left - 8 : STAGE.right + 8} cy={WINDOW_Y[i]} r="3.5" />
                </g>
              )),
            )}
          </svg>
          <ul className="l-chips l-chips-l" aria-label="Integrations">
            {left.map((name, i) => (
              <li key={name} className="l-chip" style={{ top: CHIP_Y[i] }} translate="no">
                {name}
              </li>
            ))}
          </ul>
          <div className="l-chat-center">
            {near ? (
              <Suspense fallback={<ChatPlaceholder />}>
                <ChatShowcase source={source} />
              </Suspense>
            ) : (
              <ChatPlaceholder />
            )}
          </div>
          <ul className="l-chips l-chips-r" aria-label="More integrations">
            {right.map((name, i) => (
              <li key={name} className="l-chip" style={{ top: CHIP_Y[i] }} translate="no">
                {name}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </GridSection>
  );
}

function ChatPlaceholder() {
  return (
    <div className="l-chat-window l-chat-window-pending" aria-busy="true">
      <p className="l-lede">Loading the chat…</p>
    </div>
  );
}
