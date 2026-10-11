// Keyboard hint labels for the shell (moved from the removed Ask panel).

/** Apple platforms show ⌘ in key hints; everything else shows Ctrl. Both keys always work. */
export const IS_APPLE_PLATFORM =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent,
  );
export const MOD_KEY_LABEL = IS_APPLE_PLATFORM ? "⌘" : "Ctrl";
