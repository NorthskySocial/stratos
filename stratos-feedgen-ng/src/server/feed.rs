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
        Ok(Ok(verified)) => verified,
        Ok(Err(error)) => {
            return xrpc_error(
                StatusCode::UNAUTHORIZED,
                error.code(),
                "authentication failed",
            );
        }
        Err(_) => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let Some(raw_query) = raw_query else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    };
    if raw_query.len() > MAX_GET_FEED_QUERY_BYTES {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    }
    let parameters: GetFeedParameters = match serde_urlencoded::from_str(&raw_query) {
        Ok(parameters) => parameters,
        Err(_) => {
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
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    }
    let limit = parameters.limit.unwrap_or(50);
    if limit == 0 || limit > 100 {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "limit must be between 1 and 100",
        );
    }
    let permit = match Arc::clone(&state.request_permits).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    if let Err(error) = ensure_viewer_authorization(&state, &verified.viewer_did, now).await {
        return feed_error(error);
    }
    let as_of = current_timestamp();
    let lifecycle = Arc::clone(&state.lifecycle);
    let server = Arc::clone(&state.server);
    let viewer_did = verified.viewer_did;
    let feed_id = parameters.feed;
    let cursor = parameters.cursor;
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
        Ok(Ok(Ok(body))) => private_json(StatusCode::OK, body),
        Ok(Ok(Err(error))) => feed_error(error),
        Ok(Err(_)) => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
        Err(_) => {
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
