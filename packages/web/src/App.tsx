// Dashboard under /app/*: one data provider, one shell, routes from src/routes.tsx.
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { AppShell } from "./components/shell";
import { Button, Page, PageHeader } from "./ui";
import { DataProvider } from "./app/catalog";
import { redirectTarget, redirects, relativePath, routes, type Redirect } from "./routes";

function RedirectTo({ redirect }: { redirect: Redirect }) {
  const { search } = useLocation();
  const params = useParams();
  return <Navigate to={redirectTarget(redirect, params, search)} replace />;
}

/** A page header like every dashboard page, so the 404 has the page's one h1. */
function NotFound() {
  return (
    <Page>
      <PageHeader
        title="Page not found"
        summary="No dashboard page lives at this address."
        action={
          <Button asChild>
            <Link to="/app/run">Open the run</Link>
          </Button>
        }
      />
    </Page>
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
