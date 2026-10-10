import { useEffect, useState } from "react";
export function useTheme() {
  const [dark, setDark] = useState(
    () => localStorage.getItem("notary-theme") === "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("notary-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, setDark] as const;
}
