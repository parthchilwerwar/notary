// The few glyphs Chat needs, inline (decorative: always aria-hidden; the control carries the name).
type IconProps = { size?: number; className?: string; strokeWidth?: number };

function Icon({ size = 16, className, d, solid = false, strokeWidth = 1.6 }: IconProps & { d: string; solid?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill={solid ? "currentColor" : "none"}
      stroke={solid ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export const CaretRight = (p: IconProps) => <Icon size={12} {...p} strokeWidth={2} d="M6 3.5L10.5 8 6 12.5" />;
export const CaretDown = (p: IconProps) => <Icon size={14} {...p} strokeWidth={1.8} d="M3.5 6L8 10.5 12.5 6" />;
export const ArrowUp = (p: IconProps) => <Icon {...p} strokeWidth={2} d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />;
export const ArrowDown = (p: IconProps) => <Icon size={14} {...p} strokeWidth={2} d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />;
export const StopSquare = (p: IconProps) => <Icon size={12} {...p} solid d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5z" />;
export const Plus = (p: IconProps) => <Icon {...p} strokeWidth={1.8} d="M8 3v10M3 8h10" />;
export const Trash = (p: IconProps) => <Icon size={14} {...p} d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8l.7-8.2" />;
export const CopyIcon = (p: IconProps) => <Icon size={14} {...p} d="M5.5 5.5v-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />;
export const CheckIcon = (p: IconProps) => <Icon size={14} {...p} strokeWidth={2} d="M3.5 8.5l3 3 6-7" />;
export const External = (p: IconProps) => <Icon size={13} {...p} d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />;
