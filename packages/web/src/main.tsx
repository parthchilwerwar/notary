import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router";
import Landing from "./Landing";
import { DataSourceProvider } from "./data";
// The kit's states (after Landing, so kit.css keeps its place after landing.css in the cascade).
// The 404 link uses the kit Button's classes directly: the component would add Radix Slot and
// tailwind-merge to the landing's first chunk.
import { EmptyState, PageSkeleton } from "./ui/States";
import "./ui/kit.css";

// The dashboard is its own chunk, so the landing (`/`) never downloads it (Lighthouse, R4).
const App = lazy(() => import("./App"));
function RouteScroll() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// No app-wide mode banner (DECISIONS #182): the landing has no mode chrome, the dashboard states the
// mode only where a live action fails, and fixture pages carry their own fixture note.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DataSourceProvider>
      <BrowserRouter>
        <RouteScroll />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route
            path="/app/*"
            element={
              <Suspense
                fallback={
                  <main className="app-loading">
                    <PageSkeleton label="Loading the dashboard…" />
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
              <main className="app-loading">
                <EmptyState
                  title="Page not found"
                  action={
                    <Link className="btn ui-btn-primary ui-btn-md" to="/">
                      Return to Notary
                    </Link>
                  }
                >
                  No page lives at this address.
                </EmptyState>
              </main>
            }
          />
        </Routes>
      </BrowserRouter>
    </DataSourceProvider>
  </StrictMode>,
);
