// Dashboard under /app/*: one data provider, one shell, routes from src/routes.tsx.
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { AppShell } from "./components/shell";
import { EmptyState } from "./components/ui/states";
import { Button } from "./components/ui/button";
import { DataProvider } from "./state/DataProvider";
import { redirects, relativePath, routes } from "./routes";

function RedirectKeepingQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      actions={
        <Button asChild>
          <Link to="/app">Open the overview</Link>
        </Button>
      }
    >
      No dashboard page lives at this address.
    </EmptyState>
  );
}

export default function App() {
  return (
    <DataProvider>
      <AppShell>
        <Routes>
          {routes.map((route) =>
            route.path === "/app" ? (
              <Route key={route.id} index element={route.element} />
            ) : (
              <Route
                key={route.id}
                path={relativePath(route.path)}
                element={route.element}
              />
            ),
          )}
          {redirects.map((r) => (
            <Route
              key={r.from}
              path={relativePath(r.from)}
              element={<RedirectKeepingQuery to={r.to} />}
            />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppShell>
    </DataProvider>
  );
}
