These rules hold for every `pds`-custody member.

1. **Never trust a boundary written on a `pds` record.** A PDS does not ask
   Stratos before it accepts a write. Any account can write a record into a
   Stratos space URI in its own repository. The boundary on that record is the
   author's claim. Stratos and the feed generator derive the boundary from
   enrollment state.
2. **Membership decides whose repository is read.** That is the only control
   on the write side. Removing a member does not stop them writing to their own
   PDS. It stops Stratos and the feed generator from reading it.
3. **A space record has a longer address.** It is `at:space/` plus six parts
   and starts with the authority:
   `at:space/{authorityDid}/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
   A Stratos-hosted record keeps the familiar
   `at://{authorDid}/{collection}/{rkey}`. The first part of a space record
   is the Stratos service DID, not the author.
