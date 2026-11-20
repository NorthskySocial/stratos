# Screenshots the docs need

This file is for docs contributors. It is not built into the site.

The docs show no screenshot yet. Capture each one below from a real running
service, then place it on its page inside a `<Figure>` component. Do not add a
`<Figure>` for a screenshot that does not exist.

## How to capture

- Use a test service with test accounts. Use names from 90s anime for test
  data, as in the code tests.
- Show no real DIDs, handles, tokens, or post content.
- Capture the light theme at 1280 pixels wide. Add a dark capture only when a
  page needs it.
- Save the file under `docs/public/screenshots/`, named after the page and
  section, for example `operator-boundaries-members.png`.
- Write alt text that states what the reader must notice.

## Admin interface

| Page                        | Section                      | The screenshot must show                                                                     |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `operator/configuration.md` | Admin authorization          | The admin interface after sign-in, with the Health, Boundaries, Enrollments, and Admins tabs |
| `operator/boundaries.md`    | Manage boundaries in Stratos | The Boundaries tab with several boundaries, one of them inactive                             |
| `operator/boundaries.md`    | Overview                     | One boundary's Overview tab with its stored policy                                           |
| `operator/boundaries.md`    | Members                      | The Members tab with a membership change preview that names the target DID and the boundary  |
| `operator/boundaries.md`    | Settings                     | The Settings tab after **Save changes**, with the review and the **Confirm save** button     |
| `operator/boundaries.md`    | Unsaved settings             | The **Stay** or **Discard** prompt                                                           |
| `operator/boundaries.md`    | Deactivate and reactivate    | A boundary card that shows **Deactivating** and the remaining member count                   |
| `operator/configuration.md` | Admin authorization          | The Admins tab, with a configuration-listed admin that cannot be revoked                     |

## Demo web app

| Page                  | Section                 | The screenshot must show                                             |
| --------------------- | ----------------------- | -------------------------------------------------------------------- |
| `guide/webapp.md`     | What you can do with it | The sign-in screen                                                   |
| `guide/webapp.md`     | What you can do with it | The enrollment status with the user's boundaries                     |
| `guide/webapp.md`     | What you can do with it | The composer with a private post and one boundary chosen             |
| `guide/webapp.md`     | What you can do with it | The feed that mixes public posts with private posts                  |
| `guide/webapp.md`     | What you can do with it | The record inspector with a private post's URI, CID, and raw content |
| `guide/first-post.md` | 4. Write the post       | The new private post in the web app, as the result of the tutorial   |
