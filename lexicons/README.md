# Stratos lexicons

Lexicon sources live in `lexicons/zone/stratos/` and `lexicons-spaces/zone/stratos/`. Key lexicons:

| Lexicon                              | Type         | Description                                                 |
| ------------------------------------ | ------------ | ----------------------------------------------------------- |
| `zone.stratos.actor.enrollment`      | record       | User's Stratos service enrollments                          |
| `zone.stratos.boundary.defs`         | defs         | Domain/Domains type definitions                             |
| `zone.stratos.feed.post`             | record       | Post with boundary                                          |
| `zone.stratos.repo.hydrateRecord`    | query        | Single record hydration endpoint                            |
| `zone.stratos.repo.hydrateRecords`   | procedure    | Batch hydration endpoint (up to 100 records)                |
| `zone.stratos.repo.createRecord`     | procedure    | Create one record in a boundary                             |
| `zone.stratos.repo.putRecord`        | procedure    | Create or update one record in a boundary                   |
| `zone.stratos.repo.deleteRecord`     | procedure    | Delete one record from a boundary                           |
| `zone.stratos.repo.applyWrites`      | procedure    | Apply 1 to 200 writes in a boundary as one commit           |
| `zone.stratos.sync.subscribeRecords` | subscription | WebSocket firehose                                          |
| `zone.stratos.sync.getRepo`          | query        | Export full repository as CAR file                          |
| `zone.stratos.repo.importRepo`       | procedure    | Import repository from CAR file                             |
| `zone.stratos.feedgen.getFeed`       | query        | Authenticated; returns fully-hydrated boundary-scoped posts |
| `zone.stratos.feedgen.describeFeed`  | query        | Unauthenticated; returns the configured feed list           |

### Adding New Lexicons

1. Add the JSON schema to the appropriate lexicon source directory.
2. Run `pnpm run codegen` from the workspace root to regenerate the client's `stratos-client/src/lexicons.gen.ts` bundle from both source directories.
3. Update handlers and their types as needed. This command generates a `LexiconDoc[]` bundle, not handler types.
