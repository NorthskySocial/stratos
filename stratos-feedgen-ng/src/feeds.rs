use std::{collections::BTreeMap, fmt};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedDescription {
    pub id: String,
    pub boundary: String,
    pub display_name: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::{FeedDescription, FeedRegistry, FeedRegistryError};

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
}
