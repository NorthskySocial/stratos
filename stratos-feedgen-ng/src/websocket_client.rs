use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{HeaderValue, header::AUTHORIZATION},
};
use url::Url;

pub(crate) fn authenticated_client_request(
    url: &Url,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, ()> {
    let mut request = url.as_str().into_client_request().map_err(|_| ())?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| ())?,
    );
    Ok(request)
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::authenticated_client_request;

    #[test]
    fn builds_an_authenticated_websocket_handshake() {
        let request = authenticated_client_request(
            &Url::parse("wss://stratos.example.test/xrpc/subscribe").unwrap(),
            "signed-token",
        )
        .unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer signed-token");
        assert_eq!(request.headers()["connection"], "Upgrade");
        assert_eq!(request.headers()["upgrade"], "websocket");
        assert!(request.headers().contains_key("sec-websocket-key"));
        assert_eq!(request.headers()["sec-websocket-version"], "13");
    }
}
