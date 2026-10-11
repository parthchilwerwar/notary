// The certificate seal from the landing's How it works art (HowArt.tsx): an accent ring, an inner
// accent-soft disc, "NOTARIZED · NOTARY ·" set on a circular path, and a check. `spin` is the text
// ring's rotation in degrees, `check` 0–1 draws the check.
import { C, SANS } from "../theme";

const SEAL_TEXT = "NOTARIZED · NOTARY · NOTARIZED · NOTARY · ";
// Circumference of the r=44 text path, for the check's dash and the text length.
const CHECK_LEN = 42;

export function Seal({ size, spin, check, id }: { size: number; spin: number; check: number; id: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <path id={id} d="M 60 60 m -44 0 a 44 44 0 1 1 88 0 a 44 44 0 1 1 -88 0" />
      </defs>
      <circle cx="60" cy="60" r="56" fill={C.page} stroke={C.accent} strokeWidth="1.25" />
      <circle cx="60" cy="60" r="33" fill={C.accentSoft} stroke={C.accent} strokeWidth="1.25" />
      <g transform={`rotate(${spin} 60 60)`}>
        <text fill={C.accent} style={{ fontFamily: SANS, fontSize: 9.5, fontWeight: 600, letterSpacing: "0.12em" }}>
          <textPath href={`#${id}`} textLength="276" lengthAdjust="spacing">
            {SEAL_TEXT}
          </textPath>
        </text>
      </g>
      <path
        d="M47 61l9 9 17-20"
        fill="none"
        stroke={C.accent}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={CHECK_LEN}
        strokeDashoffset={CHECK_LEN * (1 - check)}
      />
    </svg>
  );
}
