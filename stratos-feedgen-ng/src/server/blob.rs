use super::*;

#[derive(Deserialize)]
struct GetBlobParameters {
    uri: String,
    cid: String,
}

pub(super) async fn get_blob(
    State(state): State<Arc<FeedServerState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Response {
    let Some(blobs) = &state.blobs else {
        return xrpc_error(StatusCode::NOT_FOUND, "BlobNotFound", "blob is unavailable");
    };
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
        Ok(Ok(value)) => value,
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
    let Some(query) = raw_query else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "blob request parameters are invalid",
        );
    };
    if query.len() > MAX_GET_FEED_QUERY_BYTES {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "blob request parameters are invalid",
        );
    }
    let parameters: GetBlobParameters = match serde_urlencoded::from_str(&query) {
        Ok(value) => value,
        Err(_) => {
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "blob request parameters are invalid",
            );
        }
    };
    if parameters.uri.len() > 2_048 || parameters.cid.len() > 256 {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "blob request parameters are invalid",
        );
    }
    let _permit = match Arc::clone(&state.request_permits).try_acquire_owned() {
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
    let viewer = verified.viewer_did;
    let uri = parameters.uri;
    let cid = parameters.cid;
    let prepared = match tokio::task::spawn_blocking(move || {
        lifecycle.prepare_viewer_blob(&viewer, &server.feeds, &uri, now, &as_of)
    })
    .await
    {
        Ok(Ok(Some(value))) => value,
        Ok(Ok(None)) => {
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "BlobNotFound",
                "blob is unavailable",
            );
        }
        _ => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let (token, post) = prepared;
    let mime = blob_mime(&post.blob_refs_json, &cid);
    if mime.is_none() {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "BlobNotFound",
            "blob is unavailable",
        );
    }
    let bytes = match blobs.get(&post.author_did, &cid, now).await {
        Ok(bytes) => bytes,
        Err(error) => return blob_error(error),
    };
    if state.lifecycle.release_blob(token, (), now).is_none() {
        blobs.remove(&post.author_did, &cid);
        return xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        );
    }
    private_bytes(bytes.to_vec(), mime.unwrap_or("application/octet-stream"))
}

pub(super) fn blob_mime(references: &[u8], cid: &str) -> Option<&'static str> {
    let values: Vec<serde_json::Value> = serde_json::from_slice(references).ok()?;
    let mime = values
        .iter()
        .find(|value| value.get("cid").and_then(serde_json::Value::as_str) == Some(cid))?
        .get("mimeType")
        .and_then(serde_json::Value::as_str);
    match mime {
        Some("image/jpeg") => Some("image/jpeg"),
        Some("image/png") => Some("image/png"),
        Some("image/gif") => Some("image/gif"),
        Some("image/webp") => Some("image/webp"),
        Some("image/avif") => Some("image/avif"),
        Some("video/mp4") => Some("video/mp4"),
        Some("video/webm") => Some("video/webm"),
        Some("audio/mpeg") => Some("audio/mpeg"),
        Some("audio/ogg") => Some("audio/ogg"),
        Some("audio/wav") => Some("audio/wav"),
        _ => Some("application/octet-stream"),
    }
}

fn blob_error(error: BlobServiceError) -> Response {
    match error {
        BlobServiceError::TooLarge => xrpc_error(
            StatusCode::BAD_REQUEST,
            "BlobTooLarge",
            "blob is unavailable",
        ),
        BlobServiceError::Busy => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "BlobBusy",
            "blob is unavailable",
        ),
        BlobServiceError::Unavailable => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "blob is unavailable",
        ),
    }
}
