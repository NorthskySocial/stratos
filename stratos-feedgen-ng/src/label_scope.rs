//! The boundaries a label cursor was read under.
//!
//! The authority shows a service only the labels of the boundaries its
//! enrollment covers, and its cursor still moves past the others. A cursor
//! read under one scope has therefore not seen the labels of a boundary that
//! joins the scope later.

use std::collections::BTreeSet;

/// Boundaries the feed generator serves and the authority's enrollment answer
/// covers. Kept sorted, so its stored form is stable.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LabelScope(BTreeSet<String>);

impl LabelScope {
    /// A served boundary the enrollment does not cover shows no labels, and an
    /// enrolled boundary that is not served holds no posts, so neither counts.
    pub fn served_and_entitled(
        served: impl IntoIterator<Item = String>,
        entitled: impl IntoIterator<Item = String>,
    ) -> Self {
        let entitled: BTreeSet<String> = entitled.into_iter().collect();
        Self(
            served
                .into_iter()
                .filter(|boundary| entitled.contains(boundary))
                .collect(),
        )
    }

    pub fn boundaries(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }

    /// The stored form: a JSON array in sorted order.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.0).expect("a set of strings always serializes")
    }

    /// `None` for text that is no array of strings, which a caller must treat
    /// as an unknown scope.
    pub fn from_json(text: &str) -> Option<Self> {
        serde_json::from_str::<BTreeSet<String>>(text)
            .ok()
            .map(Self)
    }

    fn is_within(&self, recorded: &LabelScope) -> bool {
        self.0.is_subset(&recorded.0)
    }
}

/// Whether a cursor read under `recorded` must be read again from the start
/// before `current` is served. An unknown scope may have missed anything. A
/// scope that only shrank has already seen every label it still needs.
pub fn requires_replay(recorded: Option<&LabelScope>, current: &LabelScope) -> bool {
    recorded.is_none_or(|recorded| !current.is_within(recorded))
}

#[cfg(test)]
mod tests {
    use super::{LabelScope, requires_replay};

    fn scope(boundaries: &[&str]) -> LabelScope {
        LabelScope::served_and_entitled(
            boundaries.iter().map(|boundary| (*boundary).to_owned()),
            boundaries.iter().map(|boundary| (*boundary).to_owned()),
        )
    }

    #[test]
    fn the_scope_is_what_is_both_served_and_entitled() {
        let served = ["bebop", "red-tail", "swordfish"].map(str::to_owned);
        let entitled = ["swordfish", "bebop", "hammer-head"].map(str::to_owned);

        let scope = LabelScope::served_and_entitled(served, entitled);

        assert_eq!(
            scope.boundaries().collect::<Vec<_>>(),
            ["bebop", "swordfish"]
        );
    }

    #[test]
    fn the_stored_form_is_sorted_and_reads_back() {
        let unsorted = LabelScope::served_and_entitled(
            ["swordfish", "bebop", "bebop"].map(str::to_owned),
            ["bebop", "swordfish"].map(str::to_owned),
        );

        assert_eq!(unsorted.to_json(), r#"["bebop","swordfish"]"#);
        assert_eq!(LabelScope::from_json(&unsorted.to_json()), Some(unsorted));
    }

    #[test]
    fn unreadable_stored_text_is_no_scope() {
        assert_eq!(LabelScope::from_json("bebop"), None);
        assert_eq!(LabelScope::from_json(r#"{"bebop":1}"#), None);
        assert_eq!(LabelScope::from_json("[1]"), None);
    }

    #[test]
    fn an_unknown_scope_is_replayed() {
        assert!(requires_replay(None, &scope(&["bebop"])));
        assert!(requires_replay(None, &scope(&[])));
    }

    #[test]
    fn a_new_boundary_is_replayed() {
        assert!(requires_replay(
            Some(&scope(&["bebop"])),
            &scope(&["bebop", "swordfish"])
        ));
        assert!(requires_replay(
            Some(&scope(&["bebop"])),
            &scope(&["swordfish"])
        ));
    }

    #[test]
    fn an_unchanged_or_smaller_scope_is_not_replayed() {
        let both = scope(&["bebop", "swordfish"]);

        assert!(!requires_replay(Some(&both), &both));
        assert!(!requires_replay(Some(&both), &scope(&["bebop"])));
        assert!(!requires_replay(Some(&both), &scope(&[])));
    }
}
