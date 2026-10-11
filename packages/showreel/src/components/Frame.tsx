// The landing's grid framework (GridFrame.tsx): hairlines at the content edges and the safe lines,
// 10px hollow nodes where they cross. Decorative.
const W = 1920;
const H = 1080;
export const EDGE_L = 120;
export const EDGE_R = 1800;
export const SAFE_T = 96;
export const SAFE_B = 984;

export function Frame({ color, node, fill, opacity = 1, draw = 1 }: { color: string; node: string; fill: string; opacity?: number; draw?: number }) {
  const r = 7;
  const pts = [EDGE_L, EDGE_R].flatMap((x) => [SAFE_T, SAFE_B].map((y) => [x, y] as const));
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0, opacity }} aria-hidden="true">
      {/* Vertical edges draw from the top; horizontal rules from the center out. */}
      <line x1={EDGE_L} x2={EDGE_L} y1={0} y2={H * draw} stroke={color} strokeWidth={1} />
      <line x1={EDGE_R} x2={EDGE_R} y1={0} y2={H * draw} stroke={color} strokeWidth={1} />
      {[SAFE_T, SAFE_B].map((y) => (
        <line key={y} x1={W / 2 - (W / 2) * draw} x2={W / 2 + (W / 2) * draw} y1={y} y2={y} stroke={color} strokeWidth={1} />
      ))}
      {pts.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r * Math.min(1, draw * 1.2)} fill={fill} stroke={node} strokeWidth={1.25} />
      ))}
    </svg>
  );
}
