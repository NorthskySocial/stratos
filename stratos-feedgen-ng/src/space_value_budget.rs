//! The count of decoded JSON values a member's cycle holds. The cycle owns one
//! budget; the archive read and the page decode charge it as they decode, so a
//! caller cannot read a record or a page without being counted.

use std::{
    cell::Cell,
    sync::atomic::{AtomicUsize, Ordering},
};

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use crate::config::MAX_SPACE_CYCLE_VALUES;

/// A cycle's allowance of decoded values, shared by everything the cycle reads.
#[derive(Debug)]
pub struct ValueBudget {
    limit: usize,
    used: AtomicUsize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OverBudget;

impl std::fmt::Display for OverBudget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the cycle holds more decoded values than allowed")
    }
}

impl std::error::Error for OverBudget {}

impl ValueBudget {
    pub fn for_cycle() -> Self {
        Self::with_limit(MAX_SPACE_CYCLE_VALUES)
    }

    pub fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            used: AtomicUsize::new(0),
        }
    }

    pub fn used(&self) -> usize {
        self.used.load(Ordering::SeqCst)
    }

    pub fn remaining(&self) -> usize {
        self.limit.saturating_sub(self.used())
    }

    /// Takes `values` from the allowance; refuses, taking nothing, when they
    /// would pass it.
    pub fn charge(&self, values: usize) -> Result<(), OverBudget> {
        self.used
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(values)
                    .filter(|total| *total <= self.limit)
            })
            .map(|_| ())
            .map_err(|_| OverBudget)
    }
}

/// The values in `value`: itself, and everything nested in it.
pub fn count_values(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(count_values).sum::<usize>(),
        Value::Object(members) => 1 + members.values().map(count_values).sum::<usize>(),
        _ => 1,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BodyCountRefusal {
    NotJson,
    OverBudget,
}

/// Counts the values of a JSON body without building them, stopping as soon as
/// the count passes `ceiling`, so an oversized body is refused before it is
/// parsed into a tree. The parser's own nesting limit applies.
pub fn count_body_values(body: &[u8], ceiling: usize) -> Result<usize, BodyCountRefusal> {
    let counted = Cell::new(0_usize);
    let mut parser = serde_json::Deserializer::from_slice(body);
    let tally = Tally {
        counted: &counted,
        ceiling,
    };
    match tally.deserialize(&mut parser).and_then(|()| parser.end()) {
        Ok(()) => Ok(counted.get()),
        Err(_) if counted.get() > ceiling => Err(BodyCountRefusal::OverBudget),
        Err(_) => Err(BodyCountRefusal::NotJson),
    }
}

// Reads a value and keeps nothing of it but how many values it held.
#[derive(Clone, Copy)]
struct Tally<'a> {
    counted: &'a Cell<usize>,
    ceiling: usize,
}

impl Tally<'_> {
    fn count_one<E: de::Error>(self) -> Result<(), E> {
        let total = self.counted.get().saturating_add(1);
        self.counted.set(total);
        if total > self.ceiling {
            return Err(E::custom("over the ceiling"));
        }
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for Tally<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Tally<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        self.count_one()
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        self.count_one()
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        self.count_one()
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        self.count_one()
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        self.count_one()
    }

    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        self.count_one()
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<(), A::Error> {
        self.count_one()?;
        while items.next_element_seed(self)?.is_some() {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut members: A) -> Result<(), A::Error> {
        self.count_one()?;
        while members.next_key::<IgnoredAny>()?.is_some() {
            members.next_value_seed(self)?;
        }
        Ok(())
    }
}

#[cfg(test)]
impl ValueBudget {
    pub fn unlimited_for_tests() -> Self {
        Self::with_limit(usize::MAX)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // A seeded generator of nested JSON, so the streaming count and the count
    // of the parsed tree are compared on shapes nobody picked by hand.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }
    }

    fn random_value(generator: &mut Lcg, depth: usize) -> Value {
        match generator.next() % if depth >= 5 { 5 } else { 7 } {
            0 => Value::Null,
            1 => json!(generator.next() % 100),
            2 => json!(format!("spike-{}", generator.next())),
            3 => json!(generator.next().is_multiple_of(2)),
            4 => json!(-(generator.next() as i64)),
            5 => Value::Array(
                (0..generator.next() % 4)
                    .map(|_| random_value(generator, depth + 1))
                    .collect(),
            ),
            _ => Value::Object(
                (0..generator.next() % 4)
                    .map(|at| (format!("k{at}"), random_value(generator, depth + 1)))
                    .collect(),
            ),
        }
    }

    #[test]
    fn every_scalar_array_and_map_counts_one_nested_values_included() {
        assert_eq!(count_values(&json!(null)), 1);
        assert_eq!(count_values(&json!("Faye")), 1);
        assert_eq!(count_values(&json!([])), 1);
        assert_eq!(count_values(&json!({})), 1);
        assert_eq!(count_values(&json!([1, 2, 3])), 4);
        // map, array, 1, 2, map, null
        assert_eq!(count_values(&json!({ "a": [1, 2, { "b": null }] })), 6);
    }

    #[test]
    fn the_count_of_a_body_is_never_below_its_tree_and_equal_to_it_without_duplicate_keys() {
        let mut generator = Lcg(0xC0FFEE);
        for _ in 0..300 {
            let value = random_value(&mut generator, 0);
            let body = serde_json::to_vec(&value).unwrap();
            assert_eq!(
                count_body_values(&body, usize::MAX),
                Ok(count_values(&value)),
                "{value}"
            );
        }
        // A repeated key is counted each time it is read; the tree keeps the
        // last, so the stream counts more, never less.
        let repeated = br#"{"a":0,"a":1}"#;
        let tree: Value = serde_json::from_slice(repeated).unwrap();
        assert_eq!(count_values(&tree), 2);
        assert_eq!(count_body_values(repeated, usize::MAX), Ok(3));
    }

    #[test]
    fn a_charge_up_to_the_limit_is_taken_and_one_more_is_refused_and_takes_nothing() {
        let budget = ValueBudget::with_limit(10);
        assert_eq!(budget.charge(4), Ok(()));
        assert_eq!(budget.charge(6), Ok(()));
        assert_eq!((budget.used(), budget.remaining()), (10, 0));
        assert_eq!(budget.charge(1), Err(OverBudget));
        assert_eq!(budget.used(), 10);

        let budget = ValueBudget::with_limit(10);
        assert_eq!(budget.charge(11), Err(OverBudget));
        assert_eq!(budget.used(), 0);
    }

    #[test]
    fn a_cycle_is_allowed_two_million_values() {
        assert_eq!(ValueBudget::for_cycle().remaining(), 2_000_000);
    }

    #[test]
    fn a_body_over_its_ceiling_is_refused_before_the_rest_of_it_is_read() {
        // The body is not JSON past the first three values; reading on would
        // say so, stopping at the ceiling does not.
        let body = b"[1,2,3,4,5,}}}}";
        assert_eq!(
            count_body_values(body, 3),
            Err(BodyCountRefusal::OverBudget)
        );
        assert_eq!(count_body_values(body, 10), Err(BodyCountRefusal::NotJson));
        assert_eq!(count_body_values(b"[1,2]", 3), Ok(3));
        assert_eq!(
            count_body_values(b"[1,2,3]", 3),
            Err(BodyCountRefusal::OverBudget)
        );
        assert_eq!(count_body_values(b"[1,2,3]", 4), Ok(4));
    }

    #[test]
    fn a_body_that_is_not_one_json_document_is_not_json() {
        for body in [&b""[..], b"{", b"[1] [2]", b"[1]x", b"nul"] {
            assert_eq!(
                count_body_values(body, usize::MAX),
                Err(BodyCountRefusal::NotJson),
                "{}",
                String::from_utf8_lossy(body)
            );
        }
    }

    #[test]
    fn a_body_nested_past_the_parsers_depth_is_not_counted_unbounded() {
        let body = format!("{}{}", "[".repeat(10_000), "]".repeat(10_000));
        assert_eq!(
            count_body_values(body.as_bytes(), usize::MAX),
            Err(BodyCountRefusal::NotJson)
        );
    }
}
