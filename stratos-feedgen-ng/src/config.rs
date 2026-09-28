use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::feeds::{FeedRegistry, FeedRegistryLoadError, load_feed_registry};
use crate::service_auth::ServiceSigningKey;
use crate::store::read_secret_file;

pub const MAX_ACTOR_CONNECTIONS: u16 = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageProfile {
    Memory,
    EncryptedVolume {
        database_path: PathBuf,
        key_path: PathBuf,
        writer_lock_path: PathBuf,
    },
}

/// Bounds how long and how much encrypted projection data may remain local.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionRetention {
    pub max_age: Duration,
    pub max_bytes: u64,
    pub stage_budget: SpaceStageBudget,
}

/// Persistent limits on unverified space records, per member and across the projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpaceStageBudget {
    pub target_rows: u64,
    pub global_rows: u64,
    pub target_bytes: u64,
    pub global_bytes: u64,
}

/// Private OTLP/HTTP metrics export is opt-in and never affects feed serving.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetricsExportConfig {
    pub otlp_http_endpoint: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedgenConfig {
    pub service_did: String,
    pub public_url: String,
    pub public_key_multibase: String,
    pub signing_key: ServiceSigningKey,
    pub stratos_service_url: String,
    pub stratos_public_url: String,
    pub stratos_service_did: String,
    pub plc_url: String,
    pub plc_private_cidrs: Option<String>,
    pub storage: StorageProfile,
    pub retention: ProjectionRetention,
    pub actor_max_connections: u16,
    pub metrics_export: MetricsExportConfig,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ConfigError {
    Missing(&'static str),
    InvalidSigningKey,
    AmbiguousSigningKeySource,
    UnreadableSigningKeyFile,
    InvalidStratosServiceUrl,
    UnsupportedStorageBackend,
    InvalidStorageProfile,
    InvalidProjectionRetention,
    InvalidActorConnectionLimit,
    InvalidMetricsExportEndpoint,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(name) => {
                write!(formatter, "missing required environment variable {name}")
            }
            Self::UnsupportedStorageBackend => {
                formatter.write_str("only sqlite storage is supported by Feedgen NG")
            }
            Self::InvalidSigningKey => formatter.write_str("invalid Feedgen NG signing key"),
            Self::AmbiguousSigningKeySource => {
                formatter.write_str("configure exactly one Feedgen NG signing key source")
            }
            Self::UnreadableSigningKeyFile => {
                formatter.write_str("unable to load the Feedgen NG signing key")
            }
            Self::InvalidStratosServiceUrl => formatter.write_str("invalid Stratos service URL"),
            Self::InvalidStorageProfile => {
                formatter.write_str("invalid Feedgen NG storage profile")
            }
            Self::InvalidProjectionRetention => {
                formatter.write_str("invalid Feedgen NG projection retention configuration")
            }
            Self::InvalidActorConnectionLimit => {
                formatter.write_str("invalid Feedgen NG actor connection limit")
            }
            Self::InvalidMetricsExportEndpoint => {
                formatter.write_str("invalid private OTLP/HTTP metrics endpoint")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

impl FeedgenConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let signing_key = load_signing_key(
            env::var("FEEDGEN_SIGNING_KEY").ok(),
            env::var("FEEDGEN_SIGNING_KEY_FILE").ok(),
        )?;
        let mut config = Self::from_values(
            env::var("FEEDGEN_SERVICE_DID").ok(),
            env::var("FEEDGEN_PUBLIC_URL").ok(),
            env::var("FEEDGEN_PUBLIC_KEY_MULTIBASE").ok(),
            signing_key,
            env::var("STRATOS_SERVICE_URL").ok(),
            env::var("STRATOS_SERVICE_DID").ok(),
            StorageValues {
                backend: env::var("FEEDGEN_STORAGE_BACKEND").ok(),
                profile: env::var("FEEDGEN_STORAGE_PROFILE").ok(),
                sqlite_path: env::var("FEEDGEN_SQLITE_PATH").ok(),
                key_path: env::var("FEEDGEN_STORAGE_KEY_PATH").ok(),
                writer_lock_path: env::var("FEEDGEN_WRITER_LOCK_PATH").ok(),
                projection_max_age_ms: env::var("FEEDGEN_PROJECTION_MAX_AGE_MS").ok(),
                projection_max_bytes: env::var("FEEDGEN_PROJECTION_MAX_BYTES").ok(),
                stage_target_max_rows: env::var("FEEDGEN_STAGE_TARGET_MAX_ROWS").ok(),
                stage_global_max_rows: env::var("FEEDGEN_STAGE_GLOBAL_MAX_ROWS").ok(),
                stage_target_max_bytes: env::var("FEEDGEN_STAGE_TARGET_MAX_BYTES").ok(),
                stage_global_max_bytes: env::var("FEEDGEN_STAGE_GLOBAL_MAX_BYTES").ok(),
            },
        )?;
        config.plc_url = env::var("PLC_DIRECTORY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://plc.directory".to_owned());
        config.plc_private_cidrs = env::var("PLC_DIRECTORY_PRIVATE_CIDRS")
            .ok()
            .filter(|value| !value.trim().is_empty());
        config.stratos_public_url = env::var("STRATOS_PUBLIC_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_service_url)
            .transpose()?
            .unwrap_or_else(|| config.stratos_service_url.clone());
        config.actor_max_connections =
            parse_actor_connection_limit(env::var("FEEDGEN_ACTOR_SYNC_MAX_CONNECTIONS").ok())?;
        config.metrics_export = MetricsExportConfig {
            otlp_http_endpoint: parse_metrics_export_endpoint(
                env::var("FEEDGEN_OTLP_METRICS_ENDPOINT").ok(),
            )?,
        };
        Ok(config)
    }

    pub fn load_feed_registry_from_env() -> Result<FeedRegistry, FeedRegistryLoadError> {
        load_feed_registry_from_values(
            env::var("FEEDGEN_FEEDS_FILE").ok(),
            env::var("FEEDGEN_FEEDS_JSON").ok(),
            env::var("FEEDGEN_FEEDS_YAML").ok(),
        )
    }
}

fn load_signing_key(
    inline_value: Option<String>,
    file_path: Option<String>,
) -> Result<Option<String>, ConfigError> {
    match (
        inline_value.filter(|value| !value.trim().is_empty()),
        file_path.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(_), Some(_)) => Err(ConfigError::AmbiguousSigningKeySource),
        (Some(value), None) => Ok(Some(value)),
        (None, Some(path)) => {
            let mut contents = read_secret_file(Path::new(&path), 128)
                .map_err(|_| ConfigError::UnreadableSigningKeyFile)?;
            let value = String::from_utf8(contents.clone())
                .map_err(|_| ConfigError::UnreadableSigningKeyFile)?;
            contents.fill(0);
            Ok(Some(value.trim().to_owned()))
        }
        (None, None) => Ok(None),
    }
}

fn load_feed_registry_from_values(
    file: Option<String>,
    inline_json: Option<String>,
    inline_yaml: Option<String>,
) -> Result<FeedRegistry, FeedRegistryLoadError> {
    load_feed_registry(file.map(PathBuf::from), inline_json, inline_yaml)
}

impl FeedgenConfig {
    fn from_values(
        service_did: Option<String>,
        public_url: Option<String>,
        public_key_multibase: Option<String>,
        signing_key: Option<String>,
        stratos_service_url: Option<String>,
        stratos_service_did: Option<String>,
        storage: StorageValues,
    ) -> Result<Self, ConfigError> {
        let StorageValues {
            backend,
            profile,
            sqlite_path,
            key_path,
            writer_lock_path,
            projection_max_age_ms,
            projection_max_bytes,
            stage_target_max_rows,
            stage_global_max_rows,
            stage_target_max_bytes,
            stage_global_max_bytes,
        } = storage;
        let storage = parse_storage(backend, profile, sqlite_path, key_path, writer_lock_path)?;
        let retention = parse_retention(
            &storage,
            projection_max_age_ms,
            projection_max_bytes,
            StageBudgetValues {
                target_rows: stage_target_max_rows,
                global_rows: stage_global_max_rows,
                target_bytes: stage_target_max_bytes,
                global_bytes: stage_global_max_bytes,
            },
        )?;
        let stratos_service_url =
            normalize_service_url(required_value(stratos_service_url, "STRATOS_SERVICE_URL")?)?;
        Ok(Self {
            service_did: required_value(service_did, "FEEDGEN_SERVICE_DID")?,
            public_url: required_value(public_url, "FEEDGEN_PUBLIC_URL")?,
            public_key_multibase: required_value(
                public_key_multibase,
                "FEEDGEN_PUBLIC_KEY_MULTIBASE",
            )?,
            signing_key: ServiceSigningKey::from_hex(&required_value(
                signing_key,
                "FEEDGEN_SIGNING_KEY",
            )?)
            .map_err(|_| ConfigError::InvalidSigningKey)?,
            stratos_public_url: stratos_service_url.clone(),
            stratos_service_url,
            stratos_service_did: required_value(stratos_service_did, "STRATOS_SERVICE_DID")?,
            plc_url: "https://plc.directory".to_owned(),
            plc_private_cidrs: None,
            storage,
            retention,
            actor_max_connections: 8,
            metrics_export: MetricsExportConfig {
                otlp_http_endpoint: None,
            },
        })
    }
}

fn normalize_service_url(value: String) -> Result<String, ConfigError> {
    let parsed = url::Url::parse(&value).map_err(|_| ConfigError::InvalidStratosServiceUrl)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ConfigError::InvalidStratosServiceUrl);
    }
    Ok(value.trim_end_matches('/').to_owned())
}

struct StorageValues {
    backend: Option<String>,
    profile: Option<String>,
    sqlite_path: Option<String>,
    key_path: Option<String>,
    writer_lock_path: Option<String>,
    projection_max_age_ms: Option<String>,
    projection_max_bytes: Option<String>,
    stage_target_max_rows: Option<String>,
    stage_global_max_rows: Option<String>,
    stage_target_max_bytes: Option<String>,
    stage_global_max_bytes: Option<String>,
}

#[derive(Default)]
struct StageBudgetValues {
    target_rows: Option<String>,
    global_rows: Option<String>,
    target_bytes: Option<String>,
    global_bytes: Option<String>,
}

const MEMORY_RETENTION_MAX_AGE: Duration = Duration::from_secs(60 * 60);
pub const MEMORY_RETENTION_MAX_BYTES: u64 = 16 * 1024 * 1024;
const DEFAULT_STAGE_TARGET_ROWS: u64 = 2_048;
const DEFAULT_STAGE_GLOBAL_ROWS: u64 = 8_192;
const MAX_STAGE_TARGET_BYTES: u64 = 16 * 1024 * 1024;

fn parse_retention(
    storage: &StorageProfile,
    max_age_ms: Option<String>,
    max_bytes: Option<String>,
    stage_values: StageBudgetValues,
) -> Result<ProjectionRetention, ConfigError> {
    if matches!(storage, StorageProfile::Memory) {
        return Ok(ProjectionRetention {
            max_age: MEMORY_RETENTION_MAX_AGE,
            max_bytes: MEMORY_RETENTION_MAX_BYTES,
            stage_budget: parse_stage_budget(MEMORY_RETENTION_MAX_BYTES, stage_values)?,
        });
    }
    let max_age_ms = required_positive_u64(max_age_ms, "FEEDGEN_PROJECTION_MAX_AGE_MS")?;
    if max_age_ms < 1_000 || max_age_ms % 1_000 != 0 {
        return Err(ConfigError::InvalidProjectionRetention);
    }
    let max_bytes = required_positive_u64(max_bytes, "FEEDGEN_PROJECTION_MAX_BYTES")?;
    if max_bytes > i64::MAX as u64 {
        return Err(ConfigError::InvalidProjectionRetention);
    }
    Ok(ProjectionRetention {
        max_age: Duration::from_millis(max_age_ms),
        max_bytes,
        stage_budget: parse_stage_budget(max_bytes, stage_values)?,
    })
}

fn parse_stage_budget(
    max_bytes: u64,
    values: StageBudgetValues,
) -> Result<SpaceStageBudget, ConfigError> {
    let read = |value: Option<String>, default: u64| -> Result<u64, ConfigError> {
        value
            .map(|value| {
                value
                    .parse::<u64>()
                    .ok()
                    .filter(|limit| *limit > 0)
                    .ok_or(ConfigError::InvalidProjectionRetention)
            })
            .unwrap_or(Ok(default))
    };
    let budget = SpaceStageBudget {
        target_rows: read(values.target_rows, DEFAULT_STAGE_TARGET_ROWS)?,
        global_rows: read(values.global_rows, DEFAULT_STAGE_GLOBAL_ROWS)?,
        target_bytes: read(
            values.target_bytes,
            (max_bytes / 4).min(MAX_STAGE_TARGET_BYTES),
        )?,
        global_bytes: read(values.global_bytes, max_bytes)?,
    };
    budget.validate(max_bytes)?;
    Ok(budget)
}

impl SpaceStageBudget {
    pub fn validate(&self, max_bytes: u64) -> Result<(), ConfigError> {
        if self.target_rows > DEFAULT_STAGE_TARGET_ROWS
            || self.target_rows > self.global_rows
            || self.target_bytes > MAX_STAGE_TARGET_BYTES
            || self.target_bytes > self.global_bytes
            || self.global_bytes > max_bytes
            || [
                self.target_rows,
                self.global_rows,
                self.target_bytes,
                self.global_bytes,
            ]
            .iter()
            .any(|limit| *limit == 0 || *limit > i64::MAX as u64)
        {
            return Err(ConfigError::InvalidProjectionRetention);
        }
        Ok(())
    }

    pub fn for_projection(max_bytes: u64) -> Result<Self, ConfigError> {
        parse_stage_budget(
            max_bytes,
            StageBudgetValues {
                target_rows: None,
                global_rows: None,
                target_bytes: None,
                global_bytes: None,
            },
        )
    }
}

fn required_positive_u64(value: Option<String>, name: &'static str) -> Result<u64, ConfigError> {
    let value = required_value(value, name)?;
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0)
        .ok_or(ConfigError::InvalidProjectionRetention)
}

fn parse_actor_connection_limit(value: Option<String>) -> Result<u16, ConfigError> {
    let Some(value) = value else {
        return Ok(8);
    };
    value
        .parse::<u16>()
        .ok()
        .filter(|value| (1..=MAX_ACTOR_CONNECTIONS).contains(value))
        .ok_or(ConfigError::InvalidActorConnectionLimit)
}

fn parse_metrics_export_endpoint(value: Option<String>) -> Result<Option<String>, ConfigError> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let endpoint =
        url::Url::parse(&value).map_err(|_| ConfigError::InvalidMetricsExportEndpoint)?;
    let private_host = match endpoint.host() {
        Some(url::Host::Ipv4(address)) => address.is_private() || address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_unique_local() || address.is_loopback(),
        Some(url::Host::Domain("collector")) => true,
        Some(url::Host::Domain(_)) => false,
        None => false,
    };
    if !matches!(endpoint.scheme(), "http" | "https")
        || !private_host
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() != "/v1/metrics"
    {
        return Err(ConfigError::InvalidMetricsExportEndpoint);
    }
    Ok(Some(endpoint.into()))
}

fn parse_storage(
    backend: Option<String>,
    profile: Option<String>,
    sqlite_path: Option<String>,
    key_path: Option<String>,
    writer_lock_path: Option<String>,
) -> Result<StorageProfile, ConfigError> {
    if backend.as_deref().is_some_and(|value| value != "sqlite") {
        return Err(ConfigError::UnsupportedStorageBackend);
    }
    match profile.as_deref().unwrap_or("ephemeral") {
        "ephemeral" => {
            if sqlite_path
                .as_deref()
                .is_some_and(|value| value != ":memory:")
            {
                return Err(ConfigError::InvalidStorageProfile);
            }
            Ok(StorageProfile::Memory)
        }
        "encrypted-volume" => {
            let database_path = required_value(sqlite_path, "FEEDGEN_SQLITE_PATH")?;
            let database_path = PathBuf::from(database_path);
            if database_path == Path::new(":memory:") || !database_path.is_absolute() {
                return Err(ConfigError::InvalidStorageProfile);
            }
            let key_path = required_value(key_path, "FEEDGEN_STORAGE_KEY_PATH")?;
            let key_path = PathBuf::from(key_path);
            let Some(database_directory) = database_path.parent() else {
                return Err(ConfigError::InvalidStorageProfile);
            };
            if !key_path.is_absolute()
                || key_path == database_path
                || key_path.starts_with(database_directory)
            {
                return Err(ConfigError::InvalidStorageProfile);
            }
            let writer_lock_path = writer_lock_path
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(format!("{}.writer-lock", database_path.display()))
                });
            if !writer_lock_path.is_absolute()
                || writer_lock_path == database_path
                || writer_lock_path == key_path
            {
                return Err(ConfigError::InvalidStorageProfile);
            }
            Ok(StorageProfile::EncryptedVolume {
                database_path,
                key_path,
                writer_lock_path,
            })
        }
        _ => Err(ConfigError::InvalidStorageProfile),
    }
}

fn required_value(value: Option<String>, name: &'static str) -> Result<String, ConfigError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(name))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        path::Path,
    };

    use super::{
        ConfigError, FeedgenConfig, StageBudgetValues, StorageProfile, StorageValues,
        load_feed_registry_from_values, parse_metrics_export_endpoint, parse_retention,
    };

    #[test]
    fn metrics_export_is_disabled_without_a_private_collector_endpoint() {
        assert_eq!(parse_metrics_export_endpoint(None).unwrap(), None);
        assert_eq!(
            parse_metrics_export_endpoint(Some("http://collector:4318/v1/metrics".to_owned()))
                .unwrap(),
            Some("http://collector:4318/v1/metrics".to_owned())
        );
    }

    #[test]
    fn metrics_export_rejects_public_or_non_metric_endpoints() {
        for endpoint in [
            "https://collector.example.com/v1/metrics",
            "http://8.8.8.8/v1/metrics",
            "http://not-a-private-collector:4318/v1/metrics",
            "http://collector:4318/not-metrics",
            "http://collector:4318/v1/metrics?token=private",
        ] {
            assert_eq!(
                parse_metrics_export_endpoint(Some(endpoint.to_owned())),
                Err(ConfigError::InvalidMetricsExportEndpoint),
                "{endpoint}"
            );
        }
    }

    #[test]
    fn durable_retention_rejects_subsecond_age_and_unrepresentable_budget() {
        let storage = StorageProfile::EncryptedVolume {
            database_path: "/tmp/feedgen.sqlite".into(),
            key_path: "/tmp/feedgen.key".into(),
            writer_lock_path: "/tmp/feedgen.lock".into(),
        };
        assert_eq!(
            parse_retention(
                &storage,
                Some("999".to_owned()),
                Some("1024".to_owned()),
                StageBudgetValues::default()
            ),
            Err(ConfigError::InvalidProjectionRetention)
        );
        assert_eq!(
            parse_retention(
                &storage,
                Some("1500".to_owned()),
                Some("1024".to_owned()),
                StageBudgetValues::default()
            ),
            Err(ConfigError::InvalidProjectionRetention)
        );
        assert_eq!(
            parse_retention(
                &storage,
                Some("1000".to_owned()),
                Some((i64::MAX as u64 + 1).to_string()),
                StageBudgetValues::default(),
            ),
            Err(ConfigError::InvalidProjectionRetention)
        );
    }

    fn storage(
        backend: Option<&str>,
        profile: Option<&str>,
        sqlite_path: Option<&str>,
        key_path: Option<&str>,
    ) -> StorageValues {
        StorageValues {
            backend: backend.map(str::to_owned),
            profile: profile.map(str::to_owned),
            sqlite_path: sqlite_path.map(str::to_owned),
            key_path: key_path.map(str::to_owned),
            writer_lock_path: None,
            projection_max_age_ms: None,
            projection_max_bytes: None,
            stage_target_max_rows: None,
            stage_global_max_rows: None,
            stage_target_max_bytes: None,
            stage_global_max_bytes: None,
        }
    }

    #[test]
    fn configuration_errors_name_the_missing_value() {
        assert_eq!(
            FeedgenConfig::from_values(
                None,
                Some("https://feedgen.example.test".to_string()),
                Some("zTestKey".to_string()),
                Some("11".repeat(32)),
                Some("https://stratos.example.test".to_string()),
                Some("did:web:stratos.example.test".to_string()),
                storage(None, None, None, None),
            )
            .unwrap_err()
            .to_string(),
            "missing required environment variable FEEDGEN_SERVICE_DID"
        );
    }

    #[test]
    fn rejects_unsupported_or_incomplete_durable_storage() {
        let base = || {
            (
                Some("did:web:feedgen.example.test".to_string()),
                Some("https://feedgen.example.test".to_string()),
                Some("zTestKey".to_string()),
                Some("11".repeat(32)),
                Some("https://stratos.example.test".to_string()),
                Some("did:web:stratos.example.test".to_string()),
            )
        };
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                storage(Some("postgres"), None, None, None),
            )
            .unwrap_err(),
            super::ConfigError::UnsupportedStorageBackend
        );
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                storage(None, Some("encrypted-volume"), Some(":memory:"), None),
            )
            .unwrap_err(),
            super::ConfigError::InvalidStorageProfile
        );
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                storage(
                    None,
                    Some("encrypted-volume"),
                    Some("/var/lib/feedgen/feedgen.sqlite"),
                    Some("/var/lib/feedgen/key"),
                ),
            )
            .unwrap_err(),
            super::ConfigError::InvalidStorageProfile
        );
    }

    #[test]
    fn loads_the_catalogue_before_startup_from_the_configured_source() {
        let registry = load_feed_registry_from_values(
            None,
            Some(r#"{"feeds":[{"id":"bebop","boundary":"bebop"}]}"#.to_string()),
            None,
        )
        .unwrap();
        assert_eq!(registry.get("bebop").unwrap().boundary, "bebop");
    }

    #[test]
    fn durable_storage_requires_explicit_bounded_projection_retention() {
        let base = || {
            (
                Some("did:web:feedgen.example.test".to_owned()),
                Some("https://feedgen.example.test".to_owned()),
                Some("zTestKey".to_owned()),
                Some("11".repeat(32)),
                Some("https://stratos.example.test".to_owned()),
                Some("did:web:stratos.example.test".to_owned()),
            )
        };
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        let mut missing_retention = storage(
            None,
            Some("encrypted-volume"),
            Some("/var/lib/feedgen/projection.sqlite"),
            Some("/var/lib/secrets/feedgen.key"),
        );
        missing_retention.projection_max_age_ms = None;
        missing_retention.projection_max_bytes = Some("1024".to_owned());
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                missing_retention,
            )
            .unwrap_err()
            .to_string(),
            "missing required environment variable FEEDGEN_PROJECTION_MAX_AGE_MS"
        );

        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        let mut retention = storage(
            None,
            Some("encrypted-volume"),
            Some("/var/lib/feedgen/projection.sqlite"),
            Some("/var/lib/secrets/feedgen.key"),
        );
        retention.projection_max_age_ms = Some("60000".to_owned());
        retention.projection_max_bytes = Some("1024".to_owned());
        let config = FeedgenConfig::from_values(
            did,
            url,
            key,
            signing_key,
            stratos_url,
            stratos_did,
            retention,
        )
        .unwrap();
        assert_eq!(config.retention.max_age.as_secs(), 60);
        assert_eq!(config.retention.max_bytes, 1024);
        assert_eq!(config.actor_max_connections, 8);
        assert_eq!(config.stratos_public_url, "https://stratos.example.test");
        assert!(matches!(
            config.storage,
            StorageProfile::EncryptedVolume { writer_lock_path, .. }
            if writer_lock_path == Path::new("/var/lib/feedgen/projection.sqlite.writer-lock")
        ));
    }

    #[test]
    fn bounds_the_actor_connection_limit_for_small_hosts() {
        assert_eq!(super::parse_actor_connection_limit(None).unwrap(), 8);
        assert_eq!(
            super::parse_actor_connection_limit(Some("64".to_owned())).unwrap(),
            64
        );
        assert_eq!(
            super::parse_actor_connection_limit(Some("65".to_owned())),
            Err(super::ConfigError::InvalidActorConnectionLimit)
        );
    }

    #[test]
    fn validates_target_and_global_stage_rows_and_bytes() {
        use super::{ConfigError, StageBudgetValues, parse_stage_budget};
        let values = |target_rows: &str,
                      global_rows: &str,
                      target_bytes: &str,
                      global_bytes: &str| StageBudgetValues {
            target_rows: Some(target_rows.to_owned()),
            global_rows: Some(global_rows.to_owned()),
            target_bytes: Some(target_bytes.to_owned()),
            global_bytes: Some(global_bytes.to_owned()),
        };
        let valid = parse_stage_budget(131_072, values("1024", "4096", "65536", "100000")).unwrap();
        assert_eq!(
            (
                valid.target_rows,
                valid.global_rows,
                valid.target_bytes,
                valid.global_bytes
            ),
            (1024, 4096, 65_536, 100_000)
        );
        for invalid in [
            values("0", "4096", "65536", "100000"),
            values("2049", "4096", "65536", "100000"),
            values("1024", "1000", "65536", "100000"),
            values("1024", "4096", "0", "100000"),
            values("1024", "4096", "100001", "100000"),
            values("1024", "4096", "65536", "131073"),
        ] {
            assert!(matches!(
                parse_stage_budget(131_072, invalid),
                Err(ConfigError::InvalidProjectionRetention)
            ));
        }
    }

    #[test]
    fn loads_a_trimmed_signing_key_from_a_private_file_without_exposing_its_path() {
        let directory =
            std::env::temp_dir().join(format!("feedgen-ng-config-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let secret_path = directory.join("signing-key");
        fs::write(&secret_path, "11\n").unwrap();
        fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600)).unwrap();

        assert_eq!(
            super::load_signing_key(None, Some(secret_path.display().to_string())).unwrap(),
            Some("11".to_owned())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_ambiguous_or_unreadable_signing_key_sources_without_exposing_paths() {
        assert_eq!(
            super::load_signing_key(Some("11".to_owned()), Some("/secret/key".to_owned())),
            Err(super::ConfigError::AmbiguousSigningKeySource)
        );
        let error =
            super::load_signing_key(None, Some("/private/missing-key".to_owned())).unwrap_err();
        assert_eq!(error, super::ConfigError::UnreadableSigningKeyFile);
        assert!(!error.to_string().contains("missing-key"));
    }

    #[test]
    fn rejects_insecure_or_symlinked_signing_key_files() {
        let directory = std::env::temp_dir().join(format!(
            "feedgen-ng-signing-key-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let key_path = directory.join("signing-key");
        fs::write(&key_path, "11").unwrap();
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            super::load_signing_key(None, Some(key_path.display().to_string())),
            Err(super::ConfigError::UnreadableSigningKeyFile)
        );

        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)).unwrap();
        let link_path = directory.join("signing-key-link");
        symlink(&key_path, &link_path).unwrap();
        assert_eq!(
            super::load_signing_key(None, Some(link_path.display().to_string())),
            Err(super::ConfigError::UnreadableSigningKeyFile)
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
