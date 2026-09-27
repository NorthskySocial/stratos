use super::*;

impl EncryptedStore {
    pub fn replace_pds_space_members(
        &mut self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
    ) -> Result<(), StoreError> {
        if boundary.is_empty()
            || boundary.len() > 256
            || !boundary.is_ascii()
            || members.len() > MAX_PDS_SPACE_MEMBER_PAGE
            || !is_utc_timestamp(reconciled_at)
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let Some((authority, name)) = boundary.split_once('/') else {
            return Err(StoreError::InvalidProjectionMutation);
        };
        if name.is_empty() || crate::identifier::Did::parse(authority.to_owned()).is_err() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let mut unique = std::collections::BTreeSet::new();
        for member in &members {
            crate::identifier::Did::parse(member.did.clone())
                .map_err(|_| StoreError::InvalidProjectionMutation)?;
            if !unique.insert(member.did.clone()) {
                return Err(StoreError::InvalidProjectionMutation);
            }
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let prior = transaction
            .prepare("SELECT did FROM membership_baseline WHERE boundary = ?1 AND custody = 'pds'")
            .map_err(StoreError::Open)?
            .query_map([boundary], |row| row.get::<_, String>(0))
            .map_err(StoreError::Open)?
            .collect::<Result<std::collections::BTreeSet<_>, _>>()
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM membership_baseline WHERE boundary = ?1 AND custody = 'pds'",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        for did in prior.difference(&unique) {
            purge_departed_pds_member(&transaction, boundary, did)?;
        }
        for member in members {
            transaction
                .execute(
                    "INSERT INTO membership_baseline (boundary, did, custody, repo_host, reconciled_at) VALUES (?1, ?2, 'pds', NULL, ?3)",
                    params![boundary, member.did, reconciled_at],
                )
                .map_err(StoreError::Open)?;
        }
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn is_current_pds_space_member(
        &self,
        boundary: &str,
        did: &str,
    ) -> Result<bool, StoreError> {
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        crate::identifier::Did::parse(did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM membership_baseline WHERE boundary = ?1 AND did = ?2 AND custody = 'pds')",
                params![boundary, did],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)
    }

    pub fn space_sync_cursor(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<Option<String>, StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        self.connection
            .query_row(
                "SELECT COALESCE(
                   (SELECT cursor FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3),
                   (SELECT cursor FROM space_cursor WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3)
                 )",
                params![space_uri, actor_did, boundary],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)
    }

    pub fn stage_authorized_space_page(
        &mut self,
        page: SpaceStagePage,
        mutations: Vec<SpaceStageMutation>,
    ) -> Result<(), StoreError> {
        validate_space_stage_page(&page)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        if !has_current_pds_space_member(&transaction, &page.boundary, &page.actor_did)? {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        for mutation in mutations {
            stage_space_mutation(&transaction, &page, mutation)?;
        }
        update_space_stage_checkpoint(&transaction, &page)?;
        transaction.commit().map_err(StoreError::Open)
    }

    #[cfg(test)]
    pub(crate) fn promote_verified_space_stage(
        &mut self,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if !is_utc_timestamp(retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        promote_space_stage_transaction(&transaction, space_uri, actor_did, retained_at)?;
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn promote_authorized_space_stage(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() || !is_utc_timestamp(retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        if !has_current_pds_space_member(&transaction, boundary, actor_did)? {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        promote_space_stage_transaction(&transaction, space_uri, actor_did, retained_at)?;
        transaction.commit().map_err(StoreError::Open)
    }

    /// Removes unverified staging data without requiring current membership.
    pub fn discard_unverified_space_stage(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3",
                params![space_uri, actor_did, boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3",
                params![space_uri, actor_did, boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3",
                params![space_uri, actor_did, boundary],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)
    }
}
