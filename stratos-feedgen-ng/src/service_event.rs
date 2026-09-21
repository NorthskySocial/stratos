use serde::Deserialize;

use crate::{authority::normalize_boundary, identifier::Did, store::is_utc_timestamp};

const MAX_SERVICE_FRAME_BYTES: usize = 32 * 1024;
const MAX_BOUNDARIES: usize = 128;
const MAX_BOUNDARY_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum EnrollmentAction {
    Enroll,
    Unenroll,
    BoundariesChanged,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnrollmentEvent {
    pub(crate) did: String,
    pub(crate) action: EnrollmentAction,
    pub(crate) boundaries: Vec<String>,
    pub(crate) observed_at: String,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ServiceEventError {
    InvalidConfiguration,
    FrameTooLarge,
    InvalidFrame,
}

impl std::fmt::Display for ServiceEventError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("service enrollment event is invalid")
    }
}

impl std::error::Error for ServiceEventError {}

/// Decodes one two-value DAG-CBOR subscription frame. Non-enrollment frames
/// are ignored; malformed enrollment frames are rejected before they can
/// mutate the encrypted projection.
pub fn parse_enrollment_event(
    frame: &[u8],
    service_did: &str,
) -> Result<Option<EnrollmentEvent>, ServiceEventError> {
    if frame.len() > MAX_SERVICE_FRAME_BYTES {
        return Err(ServiceEventError::FrameTooLarge);
    }
    Did::parse(service_did.to_owned()).map_err(|_| ServiceEventError::InvalidConfiguration)?;
    let mut deserializer = serde_cbor::de::Deserializer::from_slice(frame);
    let header =
        FrameHeader::deserialize(&mut deserializer).map_err(|_| ServiceEventError::InvalidFrame)?;
    if header.kind != "#enrollment" {
        return Ok(None);
    }
    let body = RawEnrollmentEvent::deserialize(&mut deserializer)
        .map_err(|_| ServiceEventError::InvalidFrame)?;
    if deserializer.byte_offset() != frame.len() {
        return Err(ServiceEventError::InvalidFrame);
    }
    parse_body(body, service_did).map(Some)
}

fn parse_body(
    body: RawEnrollmentEvent,
    service_did: &str,
) -> Result<EnrollmentEvent, ServiceEventError> {
    Did::parse(body.did.clone()).map_err(|_| ServiceEventError::InvalidFrame)?;
    if !is_utc_timestamp(&body.time) {
        return Err(ServiceEventError::InvalidFrame);
    }
    if body
        .service
        .as_deref()
        .is_some_and(|service| service != service_did)
    {
        return Err(ServiceEventError::InvalidFrame);
    }
    let action = match body.action.as_str() {
        "enroll" => EnrollmentAction::Enroll,
        "unenroll" => EnrollmentAction::Unenroll,
        "boundaries" => EnrollmentAction::BoundariesChanged,
        _ => return Err(ServiceEventError::InvalidFrame),
    };
    let boundaries = match action {
        EnrollmentAction::Unenroll => {
            if body
                .boundaries
                .as_ref()
                .is_some_and(|boundaries| !boundaries.is_empty())
            {
                return Err(ServiceEventError::InvalidFrame);
            }
            Vec::new()
        }
        EnrollmentAction::Enroll | EnrollmentAction::BoundariesChanged => {
            let boundaries = body.boundaries.ok_or(ServiceEventError::InvalidFrame)?;
            if boundaries.len() > MAX_BOUNDARIES
                || boundaries.iter().any(|boundary| {
                    boundary.is_empty()
                        || boundary.len() > MAX_BOUNDARY_BYTES
                        || !boundary.is_ascii()
                })
            {
                return Err(ServiceEventError::InvalidFrame);
            }
            let mut normalized = std::collections::BTreeSet::new();
            for boundary in boundaries {
                if boundary.starts_with("did:") && boundary.contains('/') {
                    let (authority, _) = boundary
                        .split_once('/')
                        .ok_or(ServiceEventError::InvalidFrame)?;
                    if authority != service_did {
                        return Err(ServiceEventError::InvalidFrame);
                    }
                }
                normalized.insert(
                    normalize_boundary(service_did, &boundary)
                        .ok_or(ServiceEventError::InvalidFrame)?,
                );
            }
            normalized.into_iter().collect()
        }
    };
    Ok(EnrollmentEvent {
        did: body.did,
        action,
        boundaries,
        observed_at: body.time,
    })
}

#[derive(Deserialize)]
struct FrameHeader {
    #[serde(rename = "t")]
    kind: String,
}

#[derive(Deserialize)]
struct RawEnrollmentEvent {
    did: String,
    action: String,
    service: Option<String>,
    boundaries: Option<Vec<String>>,
    time: String,
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    use super::{EnrollmentAction, ServiceEventError, parse_enrollment_event};

    #[derive(Serialize)]
    struct Header<'a> {
        #[serde(rename = "t")]
        kind: &'a str,
    }

    #[derive(Serialize)]
    struct Body<'a> {
        did: &'a str,
        action: &'a str,
        service: Option<&'a str>,
        boundaries: Option<Vec<&'a str>>,
        time: &'a str,
    }

    fn enrollment_frame(body: Body<'_>) -> Vec<u8> {
        let mut frame = serde_cbor::to_vec(&Header {
            kind: "#enrollment",
        })
        .unwrap();
        frame.extend(serde_cbor::to_vec(&body).unwrap());
        frame
    }

    #[test]
    fn accepts_only_a_complete_authority_bound_enrollment_frame() {
        let frame = enrollment_frame(Body {
            did: "did:plc:faye",
            action: "boundaries",
            service: Some("did:web:stratos.example.test"),
            boundaries: Some(vec!["crew", "bebop"]),
            time: "1998-04-03T00:00:00.000Z",
        });
        let event = parse_enrollment_event(&frame, "did:web:stratos.example.test")
            .unwrap()
            .unwrap();
        assert_eq!(event.action, EnrollmentAction::BoundariesChanged);
        assert_eq!(
            event.boundaries,
            [
                "did:web:stratos.example.test/bebop",
                "did:web:stratos.example.test/crew"
            ]
        );

        let mut trailing = frame;
        trailing.push(0);
        assert!(matches!(
            parse_enrollment_event(&trailing, "did:web:stratos.example.test"),
            Err(ServiceEventError::InvalidFrame)
        ));
        let mixed_authority = enrollment_frame(Body {
            did: "did:plc:faye",
            action: "enroll",
            service: Some("did:web:stratos.example.test"),
            boundaries: Some(vec!["bebop", "did:web:other.example.test/nope"]),
            time: "1998-04-03T00:00:00.000Z",
        });
        assert!(matches!(
            parse_enrollment_event(&mixed_authority, "did:web:stratos.example.test"),
            Err(ServiceEventError::InvalidFrame)
        ));
    }

    #[test]
    fn rejects_cross_service_and_invalid_unenrollment_frames() {
        let cross_service = enrollment_frame(Body {
            did: "did:plc:faye",
            action: "enroll",
            service: Some("did:web:other.example.test"),
            boundaries: Some(vec!["bebop"]),
            time: "1998-04-03T00:00:00.000Z",
        });
        assert!(matches!(
            parse_enrollment_event(&cross_service, "did:web:stratos.example.test"),
            Err(ServiceEventError::InvalidFrame)
        ));
        let unenroll = enrollment_frame(Body {
            did: "did:plc:faye",
            action: "unenroll",
            service: None,
            boundaries: Some(vec!["bebop"]),
            time: "1998-04-03T00:00:00.000Z",
        });
        assert!(matches!(
            parse_enrollment_event(&unenroll, "did:web:stratos.example.test"),
            Err(ServiceEventError::InvalidFrame)
        ));
        let invalid_time = enrollment_frame(Body {
            did: "did:plc:faye",
            action: "unenroll",
            service: None,
            boundaries: None,
            time: "not-a-time",
        });
        assert!(matches!(
            parse_enrollment_event(&invalid_time, "did:web:stratos.example.test"),
            Err(ServiceEventError::InvalidFrame)
        ));
    }
}
