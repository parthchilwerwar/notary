// The UI kit (K2): components extracted from the landing, shared by the landing and the dashboard.
// Colors, type and geometry come only from src/design/tokens.css (+ brand primitives in
// src/design/brand.css); kit styles live in ./kit.css. Dashboard pages and the shell import UI from
// here only (test/ui-kit-boundary.test.ts).
import "./kit.css";

export { Card, WashCard } from "./Card";
export { Timeline, TimelineItem, TimelineMarker, type TimelineMark, type TimelineTone } from "./Timeline";
export { AgentBadge } from "./AgentBadge";
export { Button, type ButtonVariant } from "./Button";
export { StatusPill, toneFor, type StatusTone } from "./StatusPill";
export { Title, SectionLabel, Section } from "./Title";
export { PageHeader, PageHeaderContext, SkyBand, SkyBandContext, Page, PageBody } from "./PageHeader";
export { Stat, StatRow } from "./Stat";
export { Seal, CertificateCard } from "./CertificateCard";
export { EmptyState, NoRunsYet, Skeleton, PageSkeleton, Expander } from "./States";
export { Note, FixtureNote, ReplayBadge, Facts, Pills, Select, TableFrame, type NoteTone } from "./Bits";
export { RecordLinks, Trace, Json, traceUrl } from "./Records";
export { usePageMotion, slideIn } from "./motion";
// The landing's own components, re-exported rather than forked.
export { Clouds } from "../components/brand/Clouds";
export { BrowserFrame } from "../components/landing/BrowserFrame";
// The landing's dithered naive-vs-guarded chart (Proof section) and the shared dither renderer.
export { ActionsChart as DitherChart } from "../components/landing/ActionsChart";
export { DitherCanvas, DitherSwatch, type DitherFill } from "../components/brand/DitherCanvas";
// Rare UI's Hook Sidebar (docs/CREDITS.md): the dashboard navigation and the Run transcript's event rail.
export { HookSidebar, type HookSidebarItem } from "../components/ui/hook-sidebar";
