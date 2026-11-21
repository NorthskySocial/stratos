//! The harness runs the Rust tests it names, by name, so a name no test
//! answers to would quietly turn a contract into nothing, and a list that
//! shrinks would drop one.

use std::{fs, path::Path};

const CONTRACTS: &str = include_str!("../../test/feedgen-harness/contracts.ts");
const PRIVACY_CONTRACTS: usize = 16;
const RECOVERY_CONTRACTS: usize = 15;

fn names_in(list: &str) -> Vec<&'static str> {
    let start = CONTRACTS
        .find(&format!("  {list}: ["))
        .unwrap_or_else(|| panic!("the {list} list is in contracts.ts"));
    let body = &CONTRACTS[start..];
    let end = body.find("],").expect("the list ends");
    body[..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix('\''))
        .filter_map(|line| line.strip_suffix("',"))
        .collect()
}

fn rust_sources(directory: &Path, found: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push((
                path.display().to_string(),
                fs::read_to_string(&path).unwrap(),
            ));
        }
    }
}

#[test]
fn the_harness_lists_keep_their_length() {
    assert_eq!(names_in("privacy").len(), PRIVACY_CONTRACTS);
    assert_eq!(names_in("recovery").len(), RECOVERY_CONTRACTS);
}

#[test]
fn every_name_in_the_harness_lists_is_a_test_in_the_source() {
    let mut sources = Vec::new();
    rust_sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut sources,
    );
    for name in names_in("privacy").into_iter().chain(names_in("recovery")) {
        let segments: Vec<&str> = name.split("::").collect();
        let (module, function) = (segments[0], segments[segments.len() - 1]);
        let defined = sources.iter().any(|(path, text)| {
            let in_module =
                path.contains(&format!("/{module}.rs")) || path.contains(&format!("/{module}/"));
            in_module && text.contains(&format!("fn {function}("))
        });
        assert!(defined, "{name} is not a test in the source");
    }
}
