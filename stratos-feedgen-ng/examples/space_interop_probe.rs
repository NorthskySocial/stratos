use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::{Value, json};
use stratos_feedgen_ng::{
    credential_issuer::HttpSpaceCredentialIssuer,
    credential_manager::SpaceCredentialManager,
    identifier::Did,
    service_auth::ServiceSigningKey,
    space_http_signature::{SpaceHttpSignatureHeaders, SpaceHttpSignatureKey},
};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case")]
enum Request {
    ManagerInit {
        authority: String,
        authority_did: String,
        feedgen_did: String,
        signing_key: String,
    },
    ManagerGet {
        boundary: String,
        audience: String,
    },
    Generate {
        grant: String,
    },
    Exchange {
        grant: String,
        delegation: String,
    },
    Present {
        grant: String,
        credential: String,
        audience: String,
    },
}

fn headers(value: SpaceHttpSignatureHeaders) -> Value {
    let mut result = json!({
        "authorization": value.authorization(),
        "signature-input": value.signature_input(),
        "signature": value.signature(),
    });
    if let Some(audience) = value.audience() {
        result["atproto-space-audience"] = json!(audience);
    }
    result
}

async fn execute(
    request: Request,
    keys: &mut HashMap<String, SpaceHttpSignatureKey>,
    manager: &mut Option<SpaceCredentialManager>,
) -> Value {
    match request {
        Request::ManagerInit {
            authority,
            authority_did,
            feedgen_did,
            signing_key,
        } => {
            let issuer = HttpSpaceCredentialIssuer::new(
                &authority,
                &authority,
                authority_did,
                feedgen_did,
                ServiceSigningKey::from_hex(signing_key.trim()).expect("invalid service key"),
            )
            .expect("invalid issuer");
            *manager = Some(SpaceCredentialManager::new(Arc::new(issuer)));
            json!({"ready": true})
        }
        Request::ManagerGet { boundary, audience } => {
            match manager
                .as_ref()
                .expect("manager missing")
                .get(&boundary)
                .await
            {
                Ok(grant) => {
                    json!({"keyId": grant.key_id(), "headers": headers(grant.presentation_headers(&Did::parse(audience).expect("invalid audience")).expect("invalid presentation"))})
                }
                Err(_) => json!({"denied": true}),
            }
        }
        Request::Generate { grant } => {
            assert!(!keys.contains_key(&grant));
            let key = SpaceHttpSignatureKey::generate();
            let result = json!({"keyId": key.key_id()});
            keys.insert(grant, key);
            result
        }
        Request::Exchange { grant, delegation } => headers(
            keys[&grant]
                .exchange_headers(&delegation)
                .expect("invalid exchange input"),
        ),
        Request::Present {
            grant,
            credential,
            audience,
        } => headers(
            keys[&grant]
                .presentation_headers(
                    &credential,
                    &Did::parse(audience).expect("invalid audience"),
                )
                .expect("invalid presentation input"),
        ),
    }
}

#[tokio::main]
async fn main() {
    // Keys and bearer values stay in the pipe and process memory, never arguments or files.
    let mut keys = HashMap::new();
    let mut manager = None;
    for line in io::stdin().lock().lines() {
        let request =
            serde_json::from_str(&line.expect("input unavailable")).expect("invalid probe request");
        println!("{}", execute(request, &mut keys, &mut manager).await);
        io::stdout().flush().expect("output unavailable");
    }
}
