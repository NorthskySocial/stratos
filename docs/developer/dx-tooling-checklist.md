# Implementation Checklist: 4. Developer Experience & Tooling

This checklist tracks the implementation of improvements to the developer experience and tooling for the Stratos project, as outlined in the [Improvement Plan](../../improvementplan.md).

## 4.1. Unified Local Development Environment

Goal: Create a comprehensive `docker-compose` setup that includes a mock PDS, the Stratos service, the indexer, and a mock AppView to simplify onboarding.

- [ ] **Mock PDS Service Integration**
    - [ ] Research and select a mock PDS (e.g., a lightweight version of `bluesky-social/pds` or a custom stub).
    - [ ] Configure mock PDS in `docker-compose.yml`.
    - [ ] Set up automated DID generation for mock users in the local environment.
- [ ] **Mock AppView Service Integration**
    - [ ] Create a minimal `AppView` stub that can consume the `stratos-indexer`'s database.
    - [ ] Add the mock AppView to `docker-compose.yml`.
    - [ ] Implement a basic feed endpoint in the mock AppView for local testing.
- [ ] **Environment Orchestration**
    - [ ] Standardize environment variables across all services for local development.
    - [ ] Create a `scripts/setup-local-env.sh` to initialize the database, generate keys, and start services.
    - [ ] Update `README.md` and `docs/operator/deployment.md` with local setup instructions.

## 4.2. SDK UI Component Library

Goal: Extract common UI patterns from the WebApp into a reusable component library for React and Svelte.

- [ ] **Library Infrastructure**
    - [ ] Create a new package `stratos-ui` in the monorepo (`packages/stratos-ui` or similar).
    - [ ] Set up a build pipeline for both React and Svelte (e.g., using `tsup` or `vite`).
- [ ] **Component Extraction (Svelte)**
    - [ ] Port `EnrollmentIndicator.svelte` to the library.
    - [ ] Port `Composer.svelte` (boundary-aware) to the library.
    - [ ] Port `RecordInspector.svelte` and `PostCard.svelte` to the library.
- [ ] **Component Porting (React)**
    - [ ] Implement a React version of the `EnrollmentIndicator`.
    - [ ] Implement a React version of the boundary-aware `Composer`.
    - [ ] Ensure consistent styling and behavior across frameworks (possibly using Tailwind or headless UI).
- [ ] **Documentation & Examples**
    - [ ] Create a Storybook or a simple gallery for the components.
    - [ ] Add usage examples to the `docs/client/ui-patterns.md`.

## 4.3. Enhanced Error Reporting

Goal: Standardize error responses and provide granular error codes for client-side diagnosis.

- [ ] **Error Code Standardization**
    - [ ] Audit `stratos-core/src/shared/errors.ts` and add missing granular codes (e.g., `NamespaceViolation`, `BoundaryEscalation`).
    - [ ] Define a standard JSON schema for XRPC error responses.
- [ ] **Service-Side Implementation**
    - [ ] Update all XRPC handlers in `stratos-service` to use the new error classes.
    - [ ] Implement a global error-to-XRPC response mapper in `stratos-service`.
- [ ] **Client-Side Integration**
    - [ ] Update `@northskysocial/stratos-client` to parse and throw the granular errors.
    - [ ] Add a troubleshooting guide to the documentation linking error codes to common fixes.

## 4.4. Comprehensive API Documentation

Goal: Expand documentation with detailed examples of batch operations and advanced record filtering.

- [ ] **Batch Operations Documentation**
    - [ ] Add detailed examples for `zone.stratos.repo.hydrateRecords` (batch hydration) in `docs/client/reading-records.md`.
    - [ ] Include performance best practices for batching requests.
- [ ] **Advanced Filtering & Indexing**
    - [ ] Expand `docs/operator/appview-integration.md` with examples of filtering records by boundary and actor.
    - [ ] Document the schema used by `stratos-indexer` for AppView integrators.
- [ ] **Interactive API Explorer**
    - [ ] (Optional) Integrate an XRPC explorer (like a Swagger UI equivalent for XRPC) into the docs.
