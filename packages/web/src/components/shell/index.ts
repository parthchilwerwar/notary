// App shell: white sidebar (phones: top bar + drawer), canvas, command palette, toasts, live status.
export { AppShell, RunReceipt, useCrumbs } from "./AppShell";
export { Sidebar, MobileBar, activeNavId } from "./Sidebar";
export { CommandPalette, chatPrefillPath, paletteRoutes } from "./CommandPalette";
export { MOD_KEY_LABEL, IS_APPLE_PLATFORM } from "./keys";
export { RunPicker } from "./RunPicker";
export {
  ShellStatusProvider,
  useShellStatus,
  latestHealth,
  modeLabel,
  type LiveHealth,
  type ApprovalsCount,
} from "./status";
export { notify } from "./notify";
