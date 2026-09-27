use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FeedDescription {
    pub id: String,
    pub boundary: String,
    #[serde(rename = "displayName")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FeedRegistryError {
    EmptyId,
    EmptyBoundary,
    DuplicateId,
}

impl fmt::Display for FeedRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyId => formatter.write_str("feed id must not be empty"),
            Self::EmptyBoundary => formatter.write_str("feed boundary must not be empty"),
            Self::DuplicateId => formatter.write_str("feed id is duplicated"),
        }
    }
}

impl std::error::Error for FeedRegistryError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FeedRegistryLoadError {
    MissingSource,
    MultipleSources,
    UnsupportedFileFormat,
    ReadFile,
    InvalidDocument,
    InvalidDefinition(FeedRegistryError),
}

impl fmt::Display for FeedRegistryLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSource => formatter.write_str("a feed registry source is required"),
            Self::MultipleSources => {
                formatter.write_str("only one feed registry source is allowed")
            }
            Self::UnsupportedFileFormat => {
                formatter.write_str("feed registry file format is unsupported")
            }
            Self::ReadFile => formatter.write_str("feed registry file could not be read"),
            Self::InvalidDocument => formatter.write_str("feed registry document is invalid"),
            Self::InvalidDefinition(error) => {
                write!(formatter, "feed registry definition is invalid: {error}")
            }
        }
    }
}

impl std::error::Error for FeedRegistryLoadError {}

#[derive(Clone)]
pub struct FeedRegistry {
    feeds: BTreeMap<String, FeedDescription>,
}

impl FeedRegistry {
    pub fn new(
        feeds: impl IntoIterator<Item = FeedDescription>,
    ) -> Result<Self, FeedRegistryError> {
        let mut by_id = BTreeMap::new();
        for feed in feeds {
            if feed.id.is_empty() {
                return Err(FeedRegistryError::EmptyId);
            }
            if feed.boundary.is_empty() {
                return Err(FeedRegistryError::EmptyBoundary);
            }
            if by_id.insert(feed.id.clone(), feed).is_some() {
                return Err(FeedRegistryError::DuplicateId);
            }
        }
        Ok(Self { feeds: by_id })
    }

    pub fn get(&self, id: &str) -> Option<&FeedDescription> {
        self.feeds.get(id)
    }

    pub fn list(&self) -> impl Iterator<Item = &FeedDescription> {
        self.feeds.values()
    }
}

#[derive(Deserialize)]
struct FeedDocument {
    feeds: Vec<FeedDefinition>,
}

#[derive(Deserialize)]
struct FeedDefinition {
    id: String,
    boundary: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
}

pub fn load_feed_registry(
    file: Option<PathBuf>,
    inline_json: Option<String>,
    inline_yaml: Option<String>,
) -> Result<FeedRegistry, FeedRegistryLoadError> {
    let file = file.filter(|path| !path.as_os_str().is_empty());
    let inline_json = inline_json.filter(|document| !document.is_empty());
    let inline_yaml = inline_yaml.filter(|document| !document.is_empty());
    let sources = usize::from(file.is_some())
        + usize::from(inline_json.is_some())
        + usize::from(inline_yaml.is_some());
    if sources == 0 {
        return Err(FeedRegistryLoadError::MissingSource);
    }
    if sources > 1 {
        return Err(FeedRegistryLoadError::MultipleSources);
    }
    match (file, inline_json, inline_yaml) {
        (Some(path), None, None) => load_file(&path),
        (None, Some(document), None) => parse_json(&document),
        (None, None, Some(document)) => parse_yaml(&document),
        _ => Err(FeedRegistryLoadError::MultipleSources),
    }
}

fn load_file(path: &Path) -> Result<FeedRegistry, FeedRegistryLoadError> {
    let document = fs::read_to_string(path).map_err(|_| FeedRegistryLoadError::ReadFile)?;
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("json") => parse_json(&document),
        Some("yaml" | "yml") => parse_yaml(&document),
        _ => Err(FeedRegistryLoadError::UnsupportedFileFormat),
    }
}

fn parse_json(document: &str) -> Result<FeedRegistry, FeedRegistryLoadError> {
    serde_json::from_str(document)
        .map_err(|_| FeedRegistryLoadError::InvalidDocument)
        .and_then(build_feed_registry)
}

fn parse_yaml(document: &str) -> Result<FeedRegistry, FeedRegistryLoadError> {
    serde_yaml::from_str(document)
        .map_err(|_| FeedRegistryLoadError::InvalidDocument)
        .and_then(build_feed_registry)
}

fn build_feed_registry(document: FeedDocument) -> Result<FeedRegistry, FeedRegistryLoadError> {
    FeedRegistry::new(document.feeds.into_iter().map(|feed| FeedDescription {
        id: feed.id,
        boundary: feed.boundary,
        display_name: feed.display_name,
        description: feed.description,
    }))
    .map_err(FeedRegistryLoadError::InvalidDefinition)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{
        FeedDescription, FeedRegistry, FeedRegistryError, FeedRegistryLoadError, load_feed_registry,
    };

    fn feed(id: &str, boundary: &str) -> FeedDescription {
        FeedDescription {
            id: id.to_string(),
            boundary: boundary.to_string(),
            display_name: None,
            description: None,
        }
    }

    #[test]
    fn binds_each_feed_id_to_one_boundary_in_stable_order() {
        let registry =
            FeedRegistry::new([feed("red-tail", "red-tail"), feed("bebop", "bebop")]).unwrap();
        assert_eq!(registry.get("bebop").unwrap().boundary, "bebop");
        assert!(registry.get("unknown").is_none());
        assert_eq!(
            registry
                .list()
                .map(|feed| feed.id.as_str())
                .collect::<Vec<_>>(),
            ["bebop", "red-tail"]
        );
    }

    #[test]
    fn rejects_invalid_or_ambiguous_feed_definitions() {
        assert!(matches!(
            FeedRegistry::new([feed("", "bebop")]),
            Err(FeedRegistryError::EmptyId)
        ));
        assert!(matches!(
            FeedRegistry::new([feed("bebop", "")]),
            Err(FeedRegistryError::EmptyBoundary)
        ));
        assert!(matches!(
            FeedRegistry::new([feed("bebop", "bebop"), feed("bebop", "red-tail")]),
            Err(FeedRegistryError::DuplicateId)
        ));
    }

    #[test]
    fn loads_exactly_one_json_or_yaml_source() {
        let json = r#"{"feeds":[{"id":"bebop","boundary":"bebop","displayName":"Bebop"}]}"#;
        let yaml = "feeds:\n  - id: red-tail\n    boundary: red-tail\n    description: Red Tail";
        assert_eq!(
            load_feed_registry(None, Some(json.to_string()), None)
                .unwrap()
                .get("bebop")
                .unwrap()
                .display_name
                .as_deref(),
            Some("Bebop")
        );
        assert_eq!(
            load_feed_registry(None, None, Some(yaml.to_string()))
                .unwrap()
                .get("red-tail")
                .unwrap()
                .description
                .as_deref(),
            Some("Red Tail")
        );
        assert!(matches!(
            load_feed_registry(None, None, None),
            Err(FeedRegistryLoadError::MissingSource)
        ));
        assert!(matches!(
            load_feed_registry(None, Some(json.to_string()), Some(yaml.to_string())),
            Err(FeedRegistryLoadError::MultipleSources)
        ));
    }

    #[test]
    fn rejects_non_string_feed_values() {
        assert!(matches!(
            load_feed_registry(
                None,
                Some(r#"{"feeds":[{"id":"bebop","boundary":1}]}"#.to_string()),
                None,
            ),
            Err(FeedRegistryLoadError::InvalidDocument)
        ));
    }

    #[test]
    fn loads_supported_file_formats_and_rejects_other_file_sources() {
        let directory =
            std::env::temp_dir().join(format!("stratos-feedgen-ng-feeds-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir(&directory).unwrap();
        let json = directory.join("feeds.JSON");
        let yaml = directory.join("feeds.YAML");
        let yml = directory.join("feeds.yml");
        fs::write(&json, r#"{"feeds":[{"id":"bebop","boundary":"bebop"}]}"#).unwrap();
        fs::write(&yaml, "feeds:\n  - id: red-tail\n    boundary: red-tail").unwrap();
        fs::write(
            &yml,
            "feeds:\n  - id: hammer-head\n    boundary: hammer-head",
        )
        .unwrap();
        let unsupported = directory.join("feeds.txt");
        fs::write(&unsupported, "feeds: []").unwrap();
        for (path, id) in [(&json, "bebop"), (&yaml, "red-tail"), (&yml, "hammer-head")] {
            assert!(
                load_feed_registry(Some(path.to_path_buf()), None, None)
                    .unwrap()
                    .get(id)
                    .is_some()
            );
        }
        assert!(matches!(
            load_feed_registry(Some(unsupported), None, None),
            Err(FeedRegistryLoadError::UnsupportedFileFormat)
        ));
        assert!(matches!(
            load_feed_registry(Some(PathBuf::from("/missing/feeds.yaml")), None, None),
            Err(FeedRegistryLoadError::ReadFile)
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn ignores_empty_source_values() {
        let json = r#"{"feeds":[{"id":"bebop","boundary":"bebop"}]}"#;
        assert!(
            load_feed_registry(None, Some(json.to_string()), Some(String::new()))
                .unwrap()
                .get("bebop")
                .is_some()
        );
        assert!(matches!(
            load_feed_registry(None, Some(String::new()), Some(String::new())),
            Err(FeedRegistryLoadError::MissingSource)
        ));
        assert!(matches!(
            load_feed_registry(None, Some("   ".to_string()), None),
            Err(FeedRegistryLoadError::InvalidDocument)
        ));
    }
}
