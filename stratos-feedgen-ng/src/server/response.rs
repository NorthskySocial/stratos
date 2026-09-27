use super::*;

#[derive(Serialize)]
struct XrpcErrorResponse {
    error: &'static str,
    message: &'static str,
}

pub(super) fn xrpc_error(
    status: StatusCode,
    error: &'static str,
    message: &'static str,
) -> Response {
    let body = serde_json::to_vec(&XrpcErrorResponse { error, message })
        .expect("static XRPC error serializes");
    private_json(status, body)
}

pub(super) fn private_json(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response
}

pub(super) fn private_bytes(body: Vec<u8>, content_type: &'static str) -> Response {
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    response.headers_mut().insert(
        "content-disposition",
        HeaderValue::from_static("attachment"),
    );
    response
}

pub(super) fn current_timestamp() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond(),
    )
}
