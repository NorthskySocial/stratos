// Admin auth constants shared across E2E phases. Mirrors
// `ADMIN_SESSION_COOKIE` in stratos-service/src/oauth/admin-routes.ts; kept in
// sync manually since the Deno suite does not import the service package.

export const ADMIN_SESSION_COOKIE = 'stratos_admin_session'
