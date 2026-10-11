// App shell: sidebar, top bar (trail, run picker, search, Ask), toasts, live status.
export { AppShell, RunReceipt, useCrumbs } from "./AppShell";
export { AppSidebar, activeNavId } from "./AppSidebar";
export { CommandPalette, paletteRoutes } from "./CommandPalette";
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
