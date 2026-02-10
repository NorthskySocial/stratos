# Wishlist

Living in code so making a doc of things to address:

## Exclusive open enrollment

Open enrollment should have the possibility to allow automatic enrollment to specific domains.

If stratos allow apple, berry, tomato open enrollment should be set to auto enroll to one or more of them.

## Allow List - User List

Have the option of referencing a user list for allow list so we don't have to maintain a did collection ourselves. For the did collection option, maybe give it a friendly name and we dump it into valkey but use it specifically for bootstrapping? Otherwise we're reloading the service every time it is updated.

## Verify user membership

Appview is checking the record in a users collection to see what their endpoint and membership is. Are we verifying this against stratos?
