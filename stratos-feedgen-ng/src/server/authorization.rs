use super::*;

pub(super) async fn ensure_viewer_authorization(
    state: &FeedServerState,
    viewer_did: &str,
    now: u64,
) -> Result<(), FeedServiceError> {
    if state
        .lifecycle
        .has_current_viewer_authorization(viewer_did, now)
    {
        state.telemetry.record_cache("hit");
        return Ok(());
    }
    state.telemetry.record_cache("miss");
    let Some(authority) = &state.authority else {
        return Err(FeedServiceError::AuthorizationUnavailable);
    };
    let resolution = timeout(
        FEED_REQUEST_TIMEOUT,
        authority.resolve_enrollment(viewer_did, now),
    )
    .await
    .map_err(|_| FeedServiceError::AuthorizationUnavailable)?
    .map_err(|_| FeedServiceError::AuthorizationUnavailable)?;
    if resolution.did != viewer_did {
        return Err(FeedServiceError::AuthorizationUnavailable);
    }
    let boundaries = if resolution.enrolled {
        resolution.boundaries
    } else {
        Vec::new()
    };
    let enrolled = !boundaries.is_empty();
    state
        .lifecycle
        .apply_viewer_authorization(
            crate::authorization::ViewerAuthorization {
                did: viewer_did.to_owned(),
                boundaries,
                expires_at: now.saturating_add(BOUNDARY_AUTHORIZATION_TTL_SECONDS),
            },
            now,
        )
        .map_err(|_| FeedServiceError::AuthorizationUnavailable)?;
    if enrolled {
        Ok(())
    } else {
        Err(FeedServiceError::AuthorizationUnavailable)
    }
}
