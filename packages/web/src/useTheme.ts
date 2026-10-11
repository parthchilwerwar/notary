import { useCallback, useEffect, useState } from "react";

const KEY = "notary-theme";
/** The page color per theme: --page in src/design/tokens.css (light #FFFFFF, dark navy #0B1220). */
export const THEME_COLOR = { light: "#FFFFFF", dark: "#0B1220" } as const;

/** Stored choice first, else the OS preference. Storage may be blocked; the theme still works. */
function initialDark(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") return stored === "dark";
  } catch {
    // storage blocked: fall through to the OS preference
  }
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

export function useTheme() {
  const [dark, setDark] = useState(initialDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
  }, [dark]);
  // Only an explicit toggle is remembered, so an untouched page keeps following the OS.
  const choose = useCallback((next: boolean) => {
    setDark(next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // storage blocked: the choice lasts for this page view
    }
  }, []);
  return [dark, choose] as const;
}
