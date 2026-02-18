# Wishlist

Living in code so making a doc of things to address:

## Exclusive open enrollment

Open enrollment should have the possibility to allow automatic enrollment to specific domains.

If stratos allow apple, berry, tomato open enrollment should be set to auto enroll to one or more of them.

## Allow List - User List

Have the option of referencing a user list for allow list so we don't have to maintain a did collection ourselves. For the did collection option, maybe give it a friendly name and we dump it into valkey but use it specifically for bootstrapping? Otherwise we're reloading the service every time it is updated.

## Verify user membership

Appview is checking the record in a users collection to see what their endpoint and membership is. Are we verifying this against stratos?

## applyWrites atomicity

The `com.atproto.repo.applyWrites` handler processes create/update/delete operations sequentially, each in its own `actorStore.transact()` call. If an operation in the middle of the batch fails, earlier operations are already committed and their PDS stubs are already written.

Should wrap the entire batch in a single `actorStore.transact()` call and defer PDS stub writes until all local writes succeed. Stub writes are already non-critical (failure logged as warning), but the local store should be atomic.
