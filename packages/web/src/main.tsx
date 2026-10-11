import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./styles.css";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router";
import Landing from "./Landing";
import { DataModeBanner, DataSourceProvider } from "./data";
import { LoadingState } from "./components/ui/states";

// The dashboard is its own chunk, so the landing (`/`) never downloads it (Lighthouse, R4).
const App = lazy(() => import("./App"));
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
        <Route
          path="/app/*"
          element={
            <Suspense
              fallback={
                <main className="empty">
                  <LoadingState title="Loading the dashboard…">Fetching the app; your data loads next.</LoadingState>
                </main>
              }
            >
              <App />
            </Suspense>
          }
        />
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
