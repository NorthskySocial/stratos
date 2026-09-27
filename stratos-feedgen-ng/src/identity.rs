use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use reqwest::{Client, StatusCode, redirect::Policy};
use serde::Deserialize;
use tokio::sync::{Notify, futures::OwnedNotified};
use url::Url;

use crate::auth::{IdentityKeyResolver, IdentityResolutionError};

const DEFAULT_PLC_URL: &str = "https://plc.directory";
const RESOLVER_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
const CACHE_STALE_TTL: Duration = Duration::from_secs(5 * 60);
const CACHE_MAX_TTL: Duration = Duration::from_secs(60 * 60);
const CACHE_MAX_ENTRIES: usize = 10_000;
const CACHE_ENTRY_OVERHEAD: usize = 256;
const CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_RESOLUTIONS: usize = 128;

pub struct HttpIdentityKeyResolver {
    plc_url: Url,
    plc_private_cidrs: Vec<PrivateCidr>,
    state: Arc<Mutex<ResolverState>>,
}

impl HttpIdentityKeyResolver {
    pub fn new(
        plc_url: Option<&str>,
        private_cidrs: Option<&str>,
    ) -> Result<Self, IdentityResolutionError> {
        let plc_url = Url::parse(plc_url.unwrap_or(DEFAULT_PLC_URL))
            .map_err(|_| IdentityResolutionError::InvalidResolverUrl)?;
        validate_resolver_url(&plc_url)?;
        if plc_url.path() != "/" || plc_url.query().is_some() {
            return Err(IdentityResolutionError::InvalidResolverUrl);
        }
        let plc_private_cidrs = private_cidrs
            .map(parse_private_cidrs)
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            plc_url,
            plc_private_cidrs,
            state: Arc::new(Mutex::new(ResolverState::new())),
        })
    }
}

#[async_trait]
impl IdentityKeyResolver for HttpIdentityKeyResolver {
    async fn resolve_atproto_key(
        &self,
        did: &str,
        force_refresh: bool,
    ) -> Result<String, IdentityResolutionError> {
        if did.starts_with("did:key:") {
            return Ok(did.to_owned());
        }
        match self.begin_resolution(did, force_refresh) {
            Resolution::Cached(key) => Ok(key),
            Resolution::Rejected => Err(IdentityResolutionError::Unavailable),
            Resolution::Wait(flight, notified) => wait_for_flight(flight, notified).await,
            Resolution::Fetch(flight) => {
                let did = did.to_owned();
                let plc_url = self.plc_url.clone();
                let plc_private_cidrs = self.plc_private_cidrs.clone();
                let state = Arc::clone(&self.state);
                let owner = Arc::clone(&flight);
                tokio::spawn(async move {
                    let result = fetch_key(&plc_url, &plc_private_cidrs, &did).await;
                    if let Ok(key) = &result {
                        state
                            .lock()
                            .expect("identity cache poisoned")
                            .cache
                            .insert(&did, key);
                    }
                    complete_flight(&state, &did, &owner, result);
                });
                let notified = Arc::clone(&flight.notify).notified_owned();
                wait_for_flight(flight, notified).await
            }
        }
    }
}

enum Resolution {
    Cached(String),
    Rejected,
    Wait(Arc<ResolutionFlight>, OwnedNotified),
    Fetch(Arc<ResolutionFlight>),
}

struct ResolverState {
    cache: IdentityKeyCache,
    in_flight: BTreeMap<String, Arc<ResolutionFlight>>,
}

impl ResolverState {
    fn new() -> Self {
        Self {
            cache: IdentityKeyCache::new(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES),
            in_flight: BTreeMap::new(),
        }
    }
}

struct ResolutionFlight {
    notify: Arc<Notify>,
    result: Mutex<Option<Result<String, IdentityResolutionError>>>,
}

impl ResolutionFlight {
    fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            result: Mutex::new(None),
        }
    }
}

impl HttpIdentityKeyResolver {
    fn begin_resolution(&self, did: &str, force_refresh: bool) -> Resolution {
        let mut state = self.state.lock().expect("identity cache poisoned");
        if !force_refresh && let Some(key) = state.cache.get(did) {
            return Resolution::Cached(key);
        }
        if let Some(flight) = state.in_flight.get(did) {
            let flight = Arc::clone(flight);
            let notified = Arc::clone(&flight.notify).notified_owned();
            return Resolution::Wait(flight, notified);
        }
        if state.in_flight.len() >= MAX_IN_FLIGHT_RESOLUTIONS {
            return Resolution::Rejected;
        }
        let flight = Arc::new(ResolutionFlight::new());
        state.in_flight.insert(did.to_owned(), Arc::clone(&flight));
        Resolution::Fetch(flight)
    }
}

async fn wait_for_flight(
    flight: Arc<ResolutionFlight>,
    notified: OwnedNotified,
) -> Result<String, IdentityResolutionError> {
    if tokio::time::timeout(RESOLVER_TIMEOUT, notified)
        .await
        .is_ok()
        && let Some(result) = flight
            .result
            .lock()
            .expect("identity flight poisoned")
            .clone()
    {
        return result;
    }
    Err(IdentityResolutionError::Unavailable)
}

async fn fetch_key(
    plc_url: &Url,
    plc_private_cidrs: &[PrivateCidr],
    did: &str,
) -> Result<String, IdentityResolutionError> {
    let url = did_document_url(did, plc_url)?;
    let private_cidrs = private_cidrs_for_document(did, &url, plc_url, plc_private_cidrs);
    let document = fetch_document(url, private_cidrs).await?;
    did_key_from_document(did, &document)
}

fn private_cidrs_for_document<'a>(
    did: &str,
    url: &Url,
    plc_url: &Url,
    plc_private_cidrs: &'a [PrivateCidr],
) -> Option<&'a [PrivateCidr]> {
    (did.starts_with("did:plc:") && url.origin() == plc_url.origin()).then_some(plc_private_cidrs)
}

fn complete_flight(
    state: &Arc<Mutex<ResolverState>>,
    did: &str,
    flight: &Arc<ResolutionFlight>,
    result: Result<String, IdentityResolutionError>,
) {
    *flight.result.lock().expect("identity flight poisoned") = Some(result);
    let mut state = state.lock().expect("identity cache poisoned");
    if state
        .in_flight
        .get(did)
        .is_some_and(|current| Arc::ptr_eq(current, flight))
    {
        state.in_flight.remove(did);
    }
    drop(state);
    flight.notify.notify_waiters();
}

#[derive(Deserialize)]
struct DidDocument {
    id: String,
    #[serde(rename = "verificationMethod", default)]
    verification_methods: Vec<VerificationMethod>,
}

#[derive(Deserialize)]
struct VerificationMethod {
    id: String,
    #[serde(rename = "publicKeyMultibase")]
    public_key_multibase: Option<String>,
}

fn did_key_from_document(did: &str, document: &str) -> Result<String, IdentityResolutionError> {
    let document: DidDocument =
        serde_json::from_str(document).map_err(|_| IdentityResolutionError::InvalidDocument)?;
    if document.id != did {
        return Err(IdentityResolutionError::InvalidDocument);
    }
    let expected_id = format!("{did}#atproto");
    let key = document
        .verification_methods
        .iter()
        .find(|method| method.id == "#atproto" || method.id == expected_id)
        .and_then(|method| method.public_key_multibase.as_deref())
        .filter(|key| key.starts_with('z'))
        .ok_or(IdentityResolutionError::InvalidDocument)?;
    Ok(format!("did:key:{key}"))
}

fn did_document_url(did: &str, plc_url: &Url) -> Result<Url, IdentityResolutionError> {
    let Some((method, identifier)) = did
        .strip_prefix("did:")
        .and_then(|value| value.split_once(':'))
    else {
        return Err(IdentityResolutionError::UnsupportedDid);
    };
    match method {
        "plc" => {
            if identifier.is_empty() {
                return Err(IdentityResolutionError::UnsupportedDid);
            }
            plc_url
                .join(&format!("/{did}"))
                .map_err(|_| IdentityResolutionError::InvalidResolverUrl)
        }
        "web" => did_web_url(identifier),
        _ => Err(IdentityResolutionError::UnsupportedDid),
    }
}

fn did_web_url(identifier: &str) -> Result<Url, IdentityResolutionError> {
    if identifier.is_empty() || identifier.contains(':') || identifier.contains('%') {
        return Err(IdentityResolutionError::UnsupportedDid);
    }
    let url = Url::parse(&format!("https://{identifier}/.well-known/did.json"))
        .map_err(|_| IdentityResolutionError::UnsupportedDid)?;
    validate_resolver_url(&url)?;
    Ok(url)
}

async fn fetch_document(
    url: Url,
    plc_private_cidrs: Option<&[PrivateCidr]>,
) -> Result<String, IdentityResolutionError> {
    validate_resolver_url(&url)?;
    let host = url
        .host_str()
        .ok_or(IdentityResolutionError::InvalidResolverUrl)?;
    let addresses = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| IdentityResolutionError::Unavailable)?
        .collect::<Vec<_>>();
    let Some(address) = addresses.first().copied() else {
        return Err(IdentityResolutionError::Unavailable);
    };
    validate_addresses(&addresses, plc_private_cidrs)?;
    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(RESOLVER_TIMEOUT)
        .timeout(RESOLVER_TIMEOUT)
        .https_only(true)
        .resolve(host, address)
        .build()
        .map_err(|_| IdentityResolutionError::Unavailable)?;
    let mut response = client
        .get(url)
        .header("accept", "application/did+ld+json,application/json")
        .send()
        .await
        .map_err(|_| IdentityResolutionError::Unavailable)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(IdentityResolutionError::NotFound);
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_DOCUMENT_BYTES as u64)
    {
        return Err(IdentityResolutionError::Unavailable);
    }
    let mut document = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| IdentityResolutionError::Unavailable)?
    {
        if document.len().saturating_add(chunk.len()) > MAX_DOCUMENT_BYTES {
            return Err(IdentityResolutionError::DocumentTooLarge);
        }
        document.extend_from_slice(&chunk);
    }
    String::from_utf8(document).map_err(|_| IdentityResolutionError::InvalidDocument)
}

#[derive(Clone)]
pub(crate) enum PrivateCidr {
    V4 { network: u32, mask: u32, prefix: u8 },
    V6 { network: u128, mask: u128 },
}

impl PrivateCidr {
    fn parse(value: &str) -> Result<Self, IdentityResolutionError> {
        let (address, prefix) = value
            .split_once('/')
            .ok_or(IdentityResolutionError::InvalidPrivateResolverCidrs)?;
        let address = address
            .parse::<IpAddr>()
            .map_err(|_| IdentityResolutionError::InvalidPrivateResolverCidrs)?;
        let prefix = prefix
            .parse::<u8>()
            .map_err(|_| IdentityResolutionError::InvalidPrivateResolverCidrs)?;
        match address {
            IpAddr::V4(address) if (1..=32).contains(&prefix) && prefix != 31 => {
                let mask = u32::MAX.checked_shl(u32::from(32 - prefix)).unwrap_or(0);
                let network = u32::from(address);
                let last = network | !mask;
                if network & mask != network
                    || !is_private_address(IpAddr::V4(address))
                    || !is_private_address(IpAddr::V4(last.into()))
                {
                    return Err(IdentityResolutionError::InvalidPrivateResolverCidrs);
                }
                Ok(Self::V4 {
                    network,
                    mask,
                    prefix,
                })
            }
            IpAddr::V6(address) if (1..=128).contains(&prefix) => {
                let mask = u128::MAX.checked_shl(u32::from(128 - prefix)).unwrap_or(0);
                let network = u128::from(address);
                let last = network | !mask;
                if network & mask != network
                    || !is_private_address(IpAddr::V6(address))
                    || !is_private_address(IpAddr::V6(last.into()))
                {
                    return Err(IdentityResolutionError::InvalidPrivateResolverCidrs);
                }
                Ok(Self::V6 { network, mask })
            }
            _ => Err(IdentityResolutionError::InvalidPrivateResolverCidrs),
        }
    }

    pub(crate) fn contains(&self, address: IpAddr) -> bool {
        match (self, address) {
            (
                Self::V4 {
                    network,
                    mask,
                    prefix,
                },
                IpAddr::V4(address),
            ) => {
                let address = u32::from(address);
                (address & mask) == *network
                    && (*prefix > 30 || (address != *network && address != (*network | !mask)))
            }
            (Self::V6 { network, mask }, IpAddr::V6(address)) => {
                (u128::from(address) & mask) == *network
            }
            _ => false,
        }
    }
}

fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, ..] = address.octets();
            first == 10
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192 && second == 168)
        }
        IpAddr::V6(address) => address.segments()[0] & 0xfe00 == 0xfc00,
    }
}

pub(crate) fn parse_private_cidrs(
    value: &str,
) -> Result<Vec<PrivateCidr>, IdentityResolutionError> {
    if value.is_empty() {
        return Err(IdentityResolutionError::InvalidPrivateResolverCidrs);
    }
    value
        .split(',')
        .map(|cidr| PrivateCidr::parse(cidr.trim()))
        .collect()
}

fn validate_addresses(
    addresses: &[SocketAddr],
    plc_private_cidrs: Option<&[PrivateCidr]>,
) -> Result<(), IdentityResolutionError> {
    if addresses.is_empty() {
        return Err(IdentityResolutionError::Unavailable);
    }
    let all_public = addresses
        .iter()
        .all(|address| is_public_address(address.ip()));
    let all_trusted_private = plc_private_cidrs.is_some_and(|cidrs| {
        !cidrs.is_empty()
            && addresses
                .iter()
                .all(|address| cidrs.iter().any(|cidr| cidr.contains(address.ip())))
    });
    if all_public || all_trusted_private {
        Ok(())
    } else {
        Err(IdentityResolutionError::UnsafeResolverAddress)
    }
}

fn validate_resolver_url(url: &Url) -> Result<(), IdentityResolutionError> {
    let host = url.host_str();
    if url.scheme() != "https"
        || host.is_none()
        || url.port().is_some_and(|port| port != 443)
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || host.is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok()
        })
    {
        return Err(IdentityResolutionError::InvalidResolverUrl);
    }
    Ok(())
}

pub(crate) fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, third, _] = address.octets();
            !(first == 0
                || first == 10
                || first == 100
                || first == 127
                || (first == 169 && second == 254)
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192
                    && (second == 0 || (second == 88 && third == 99) || (second == 168)))
                || (first == 198 && matches!(second, 18 | 19 | 51))
                || (first == 203 && second == 0 && third == 113)
                || first >= 224)
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_address(IpAddr::V4(mapped));
            }
            let [first, second, ..] = address.segments();
            first & 0xe000 == 0x2000
                && !(first == 0x2001 && second < 0x0200)
                && first != 0x2002
                && !(first == 0x2620 && second == 0x004f && address.segments()[2] == 0x8000)
                && !(first == 0x3fff && second & 0xf000 == 0)
        }
    }
}

struct IdentityKeyCache {
    entries: BTreeMap<String, CachedKey>,
    bytes: usize,
    capacity: usize,
    max_entries: usize,
    next_access: u64,
}

struct CachedKey {
    key: String,
    stale_at: SystemTime,
    expires_at: SystemTime,
    last_access: u64,
}

impl IdentityKeyCache {
    fn new(capacity: usize, max_entries: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            bytes: 0,
            capacity,
            max_entries,
            next_access: 0,
        }
    }

    fn get(&mut self, did: &str) -> Option<String> {
        let now = SystemTime::now();
        let entry = self.entries.get_mut(did)?;
        if entry.expires_at <= now {
            self.remove(did);
            return None;
        }
        if entry.stale_at <= now {
            return None;
        }
        self.next_access = self.next_access.wrapping_add(1);
        entry.last_access = self.next_access;
        Some(entry.key.clone())
    }

    fn insert(&mut self, did: &str, key: &str) {
        self.remove(did);
        let weight = cache_weight(did, key);
        if weight > self.capacity || self.max_entries == 0 {
            return;
        }
        while self.entries.len() >= self.max_entries
            || self.bytes.saturating_add(weight) > self.capacity
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(did, _)| did.clone())
            else {
                return;
            };
            self.remove(&oldest);
        }
        let now = SystemTime::now();
        self.next_access = self.next_access.wrapping_add(1);
        self.bytes += weight;
        self.entries.insert(
            did.to_owned(),
            CachedKey {
                key: key.to_owned(),
                stale_at: now + CACHE_STALE_TTL,
                expires_at: now + CACHE_MAX_TTL,
                last_access: self.next_access,
            },
        );
    }

    fn remove(&mut self, did: &str) {
        if let Some(entry) = self.entries.remove(did) {
            self.bytes -= cache_weight(did, &entry.key);
        }
    }
}

fn cache_weight(did: &str, key: &str) -> usize {
    CACHE_ENTRY_OVERHEAD + did.len() + key.len()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use url::Url;

    use super::{
        HttpIdentityKeyResolver, IdentityKeyCache, IdentityResolutionError, Resolution,
        did_document_url, did_key_from_document, is_public_address, parse_private_cidrs,
        private_cidrs_for_document, validate_addresses,
    };

    const DID: &str = "did:plc:spike";
    const KEY: &str = "did:key:zDnaerR5x17KrKuA3zA49N5djXcu6u3nBQxpSM6dFjdNQoa2C";

    #[test]
    fn resolves_only_supported_did_methods_to_safe_document_urls() {
        let plc = Url::parse("https://plc.example.test/").unwrap();
        assert_eq!(
            did_document_url(DID, &plc).unwrap().as_str(),
            "https://plc.example.test/did:plc:spike"
        );
        assert_eq!(
            did_document_url("did:web:feedgen.example.test", &plc)
                .unwrap()
                .as_str(),
            "https://feedgen.example.test/.well-known/did.json"
        );
        for did in [
            "did:web:localhost",
            "did:web:example.test%3A3000",
            "did:peer:abc",
        ] {
            assert!(did_document_url(did, &plc).is_err());
        }
    }

    #[test]
    fn extracts_only_the_issuer_atproto_key_from_a_matching_document() {
        let document = format!(
            r##"{{"id":"{DID}","verificationMethod":[{{"id":"#atproto","publicKeyMultibase":"{}"}}]}}"##,
            KEY.strip_prefix("did:key:").unwrap()
        );
        assert_eq!(did_key_from_document(DID, &document).unwrap(), KEY);
        assert_eq!(
            did_key_from_document("did:plc:faye", &document),
            Err(IdentityResolutionError::InvalidDocument)
        );
    }

    #[test]
    fn rejects_non_public_resolver_addresses() {
        for address in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6("fc00::1".parse().unwrap()),
            IpAddr::V6("64:ff9b::7f00:1".parse().unwrap()),
            IpAddr::V6("2002:7f00:1::".parse().unwrap()),
            IpAddr::V6("2001:0000::1".parse().unwrap()),
            IpAddr::V6("2001:0002::1".parse().unwrap()),
            IpAddr::V6("2001:0010::1".parse().unwrap()),
            IpAddr::V6("2620:004f:8000::1".parse().unwrap()),
            IpAddr::V6("3fff::1".parse().unwrap()),
        ] {
            assert!(!is_public_address(address));
        }
        assert!(is_public_address(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    #[test]
    fn permits_only_canonical_private_cidrs_and_usable_addresses() {
        let cidrs = parse_private_cidrs("172.25.111.0/24,fd00:abcd::/48").unwrap();
        assert!(cidrs[0].contains("172.25.111.2".parse().unwrap()));
        assert!(cidrs[1].contains("fd00:abcd::2".parse().unwrap()));
        for address in ["172.25.111.0", "172.25.111.255", "172.25.112.2"] {
            assert!(!cidrs[0].contains(address.parse().unwrap()));
        }
        for invalid in [
            "172.25.111.3/24",
            "172.25.111.0/31",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "0.0.0.0/0",
            "fc00::/6",
            "::ffff:ac19:6f03/128",
            "172.25.111.0/24,",
        ] {
            assert!(parse_private_cidrs(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn rejects_mixed_or_outside_dns_answers_and_limits_private_policy_to_plc() {
        let plc = Url::parse("https://plc.internal.test").unwrap();
        let private = parse_private_cidrs("172.25.111.0/24").unwrap();
        let plc_document = did_document_url(DID, &plc).unwrap();
        assert!(private_cidrs_for_document(DID, &plc_document, &plc, &private).is_some());
        let web_document = Url::parse("https://plc.internal.test/.well-known/did.json").unwrap();
        assert!(
            private_cidrs_for_document("did:web:plc.internal.test", &web_document, &plc, &private)
                .is_none()
        );
        let other_origin = Url::parse("https://other.internal.test/did:plc:spike").unwrap();
        assert!(private_cidrs_for_document(DID, &other_origin, &plc, &private).is_none());

        let address = |value: &str| SocketAddr::new(value.parse().unwrap(), 443);
        assert_eq!(
            validate_addresses(&[address("172.25.111.2")], Some(&private)),
            Ok(())
        );
        for answers in [
            vec![address("172.25.111.2"), address("1.1.1.1")],
            vec![address("172.25.111.2"), address("172.25.112.2")],
            vec![address("172.25.111.0")],
        ] {
            assert_eq!(
                validate_addresses(&answers, Some(&private)),
                Err(IdentityResolutionError::UnsafeResolverAddress)
            );
        }
        assert_eq!(
            validate_addresses(&[address("172.25.111.2")], None),
            Err(IdentityResolutionError::UnsafeResolverAddress)
        );
        assert_eq!(validate_addresses(&[address("1.1.1.1")], None), Ok(()));
        assert_eq!(
            validate_addresses(&[address("1.1.1.1"), address("8.8.8.8")], Some(&private)),
            Ok(())
        );
    }

    #[test]
    fn evicts_least_recently_used_keys_before_exceeding_its_bound() {
        let mut cache = IdentityKeyCache::new(1_000, 2);
        cache.insert("did:plc:faye", KEY);
        cache.insert("did:plc:spike", KEY);
        assert!(cache.get("did:plc:faye").is_some());
        cache.insert("did:plc:jet", KEY);

        assert!(cache.get("did:plc:faye").is_some());
        assert!(cache.get("did:plc:spike").is_none());
        assert!(cache.get("did:plc:jet").is_some());
    }

    #[test]
    fn coalesces_an_in_flight_resolution_and_reuses_the_verified_result() {
        let resolver =
            HttpIdentityKeyResolver::new(Some("https://plc.example.test"), None).unwrap();
        let Resolution::Fetch(flight) = resolver.begin_resolution(DID, false) else {
            panic!("first resolution must fetch");
        };
        assert!(matches!(
            resolver.begin_resolution(DID, false),
            Resolution::Wait(_, _)
        ));
        resolver.state.lock().unwrap().cache.insert(DID, KEY);
        super::complete_flight(&resolver.state, DID, &flight, Ok(KEY.to_owned()));

        assert!(matches!(
            resolver.begin_resolution(DID, false),
            Resolution::Cached(key) if key == KEY
        ));
    }

    #[test]
    fn bounds_stalled_identity_resolutions_before_starting_more_requests() {
        let resolver =
            HttpIdentityKeyResolver::new(Some("https://plc.example.test"), None).unwrap();
        for index in 0..super::MAX_IN_FLIGHT_RESOLUTIONS {
            assert!(matches!(
                resolver.begin_resolution(&format!("did:plc:spike{index}"), false),
                Resolution::Fetch(_)
            ));
        }
        assert!(matches!(
            resolver.begin_resolution("did:plc:overflow", false),
            Resolution::Rejected
        ));
    }
}
