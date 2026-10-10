import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./styles.css";
import App from "./App";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router";
import Landing from "./Landing";
import { DataModeBanner, DataSourceProvider } from "./data";
function RouteScroll() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DataSourceProvider>
    <BrowserRouter>
      <DataModeBanner />
      <RouteScroll />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app/*" element={<App />} />
        <Route
          path="*"
          element={
            <main className="empty">
              <h1>Page not found</h1>
              <Link to="/">Return to Notary</Link>
            </main>
          }
        />
      </Routes>
    </BrowserRouter>
    </DataSourceProvider>
  </StrictMode>,
);
