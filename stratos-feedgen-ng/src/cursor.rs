pub const DEFAULT_FEED_LIMIT: u16 = 50;
pub const MAX_FEED_LIMIT: u16 = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedCursor {
    pub sort_at: String,
    pub uri: String,
}

impl FeedCursor {
    pub fn encode(&self) -> String {
        format!("{}::{}", self.sort_at, self.uri)
    }

    pub fn decode(value: &str) -> Option<Self> {
        let (sort_at, uri) = value.split_once("::")?;
        if sort_at.is_empty() || uri.is_empty() {
            return None;
        }
        Some(Self {
            sort_at: sort_at.to_owned(),
            uri: uri.to_owned(),
        })
    }
}

pub fn clamp_feed_limit(value: Option<f64>) -> u16 {
    let Some(value) = value else {
        return DEFAULT_FEED_LIMIT;
    };
    if !value.is_finite() {
        return DEFAULT_FEED_LIMIT;
    }
    value.floor().clamp(1.0, f64::from(MAX_FEED_LIMIT)) as u16
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_FEED_LIMIT, FeedCursor, MAX_FEED_LIMIT, clamp_feed_limit};

    #[test]
    fn preserves_the_typescript_cursor_contract() {
        let cursor = FeedCursor {
            sort_at: "2026-09-21T00:00:00.000Z".to_owned(),
            uri: "at://did:plc:spikespiegel/zone.stratos.feed.post/1".to_owned(),
        };
        assert_eq!(FeedCursor::decode(&cursor.encode()), Some(cursor));
        assert_eq!(FeedCursor::decode("missing"), None);
        assert_eq!(FeedCursor::decode("::uri"), None);
        assert_eq!(FeedCursor::decode("sort::"), None);
    }

    #[test]
    fn clamps_limits_and_uses_the_default_for_non_finite_values() {
        assert_eq!(clamp_feed_limit(None), DEFAULT_FEED_LIMIT);
        assert_eq!(clamp_feed_limit(Some(f64::NAN)), DEFAULT_FEED_LIMIT);
        assert_eq!(clamp_feed_limit(Some(-9.0)), 1);
        assert_eq!(clamp_feed_limit(Some(10.8)), 10);
        assert_eq!(clamp_feed_limit(Some(500.0)), MAX_FEED_LIMIT);
    }
}
