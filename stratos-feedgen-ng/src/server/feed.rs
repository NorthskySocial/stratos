use super::*;

#[derive(Deserialize)]
struct GetFeedParameters {
    feed: String,
    cursor: Option<String>,
    limit: Option<u16>,
}

pub(super) async fn get_feed(
    State(state): State<Arc<FeedServerState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Response {
    let verify_timer = state
        .telemetry
        .start(crate::telemetry::FeedReadStage::VerifyAuthorization);
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let now = OffsetDateTime::now_utc().unix_timestamp().max(0) as u64;
    let verified = match timeout(
        FEED_REQUEST_TIMEOUT,
        state.verifier.verify_authorization(authorization, now),
    )
    .await
    {
        Ok(Ok(verified)) => {
            verify_timer.finish(crate::telemetry::FeedReadStageOutcome::Success);
            verified
        }
        Ok(Err(error)) => {
            verify_timer.finish(crate::telemetry::FeedReadStageOutcome::Failure);
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
            return xrpc_error(
                StatusCode::UNAUTHORIZED,
                error.code(),
                "authentication failed",
            );
        }
        Err(_) => {
            verify_timer.finish(crate::telemetry::FeedReadStageOutcome::Timeout);
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::Error, None);
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let Some(raw_query) = raw_query else {
        state
            .telemetry
            .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    };
    if raw_query.len() > MAX_GET_FEED_QUERY_BYTES {
        state
            .telemetry
            .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    }
    let parameters: GetFeedParameters = match serde_urlencoded::from_str(&raw_query) {
        Ok(parameters) => parameters,
        Err(_) => {
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "feed request parameters are invalid",
            );
        }
    };
    if parameters.feed.len() > MAX_FEED_ID_BYTES
        || parameters
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > MAX_CURSOR_BYTES)
    {
        state
            .telemetry
            .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    }
    let limit = parameters.limit.unwrap_or(50);
    if limit == 0 || limit > 100 {
        state
            .telemetry
            .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "limit must be between 1 and 100",
        );
    }
    let permit = match Arc::clone(&state.request_permits).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::Error, None);
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let viewer_authorization_timer = state
        .telemetry
        .start(crate::telemetry::FeedReadStage::ViewerAuthorization);
    if let Err(error) = ensure_viewer_authorization(&state, &verified.viewer_did, now).await {
        viewer_authorization_timer.finish(crate::telemetry::FeedReadStageOutcome::Failure);
        state
            .telemetry
            .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
        return feed_error(error);
    }
    viewer_authorization_timer.finish(crate::telemetry::FeedReadStageOutcome::Success);
    let as_of = current_timestamp();
    let lifecycle = Arc::clone(&state.lifecycle);
    let server = Arc::clone(&state.server);
    let viewer_did = verified.viewer_did;
    let feed_id = parameters.feed;
    let cursor = parameters.cursor;
    let projection_timer = state
        .telemetry
        .start(crate::telemetry::FeedReadStage::ProjectionSerialization);
    let response = timeout(
        FEED_REQUEST_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            lifecycle.serve_viewer_feed(
                &viewer_did,
                &server.feeds,
                FeedQuery {
                    feed_id: &feed_id,
                    cursor: cursor.as_deref(),
                    limit,
                    now,
                    as_of: &as_of,
                    blob_base_url: &server.config.public_url,
                },
            )
        }),
    )
    .await;
    match response {
        Ok(Ok(Ok(body))) => {
            projection_timer.finish(crate::telemetry::FeedReadStageOutcome::Success);
            let posts_returned = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|response| response.get("feed")?.as_array().map(Vec::len));
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::Ok, posts_returned);
            private_json(StatusCode::OK, body)
        }
        Ok(Ok(Err(error))) => {
            projection_timer.finish(crate::telemetry::FeedReadStageOutcome::Failure);
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::ExpectedError, None);
            feed_error(error)
        }
        Ok(Err(_)) => {
            projection_timer.finish(crate::telemetry::FeedReadStageOutcome::Failure);
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::Error, None);
            xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            )
        }
        Err(_) => {
            projection_timer.finish(crate::telemetry::FeedReadStageOutcome::Timeout);
            state
                .telemetry
                .record_feed_request(crate::telemetry::FeedRequestOutcome::Error, None);
            state.lifecycle.interrupt_feed_work();
            state.lifecycle.mark_unavailable();
            xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            )
        }
    }
}

pub(super) fn feed_error(error: FeedServiceError) -> Response {
    match error {
        FeedServiceError::AuthorizationUnavailable => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
        FeedServiceError::BoundaryMismatch => xrpc_error(
            StatusCode::BAD_REQUEST,
            "BoundaryMismatch",
            "viewer is not authorized for the configured feed",
        ),
        FeedServiceError::UnknownFeed => xrpc_error(
            StatusCode::BAD_REQUEST,
            "UnknownFeed",
            "configured feed was not found",
        ),
        FeedServiceError::FeedNotReady => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
        FeedServiceError::InvalidProjection | FeedServiceError::Store(_) => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
    }
}
