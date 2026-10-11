// Dashboard under /app/*: one data provider, one shell, routes from src/routes.tsx.
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { AppShell } from "./components/shell";
import { EmptyState } from "./components/ui/states";
import { Button } from "./components/ui/button";
import { DataProvider } from "./app/catalog";
import { redirectTarget, redirects, relativePath, routes, type Redirect } from "./routes";

function RedirectTo({ redirect }: { redirect: Redirect }) {
  const { search } = useLocation();
  const params = useParams();
  return <Navigate to={redirectTarget(redirect, params, search)} replace />;
}

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      actions={
        <Button asChild>
          <Link to="/app/run">Open the run</Link>
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
          {routes.map((route) => (
            <Route key={route.id} path={relativePath(route.path)} element={route.element} />
          ))}
          {redirects.map((r) =>
            r.from === "/app" ? (
              <Route key={r.from} index element={<RedirectTo redirect={r} />} />
            ) : (
              <Route key={r.from} path={relativePath(r.from)} element={<RedirectTo redirect={r} />} />
            ),
          )}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppShell>
    </DataProvider>
  );
}
