//! Declarative rule evaluation over the file graph.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::cycles;
use crate::graph::Graph;

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub from: Vec<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub threshold: usize,
}

#[derive(Debug, Serialize)]
pub struct RuleResult {
    pub name: String,
    pub kind: String,
    pub violations: Vec<String>,
    pub warnings: Vec<String>,
    pub selected: usize,
    pub time_ms: f64,
}

impl RuleResult {
    fn ok(name: &str, kind: &str) -> Self {
        RuleResult {
            name: name.to_owned(),
            kind: kind.to_owned(),
            violations: Vec::new(),
            warnings: Vec::new(),
            selected: 0,
            time_ms: 0.0,
        }
    }
}

pub fn evaluate_one(rule: &Rule, graph: &Graph) -> Result<RuleResult, String> {
    let mut result = match rule.kind.as_str() {
        "no-file-cycles" => no_file_cycles(rule, graph),
        "no-folder-tangles" => no_folder_tangles(rule, graph),
        "no-depend" => no_depend(rule, graph),
        "max-lines" => max_lines(rule, graph),
        "max-exports" => max_exports(rule, graph),
        other => return Err(format!("unknown rule kind: {other}")),
    };
    result.violations.sort();
    result.warnings.sort();
    Ok(result)
}

fn no_file_cycles(rule: &Rule, graph: &Graph) -> RuleResult {
    let sccs = cycles::strongly_connected_components(&graph.out);
    let mut cycles: Vec<String> = Vec::new();
    for component in sccs {
        let is_cycle = component.len() > 1
            || (component.len() == 1 && graph.out[component[0]].contains(&component[0]));
        if !is_cycle {
            continue;
        }
        let mut nodes: Vec<&str> = component.iter().map(|&i| graph.files[i].path.as_str()).collect();
        nodes.sort_unstable();
        let mut cycle = nodes.join(" -> ");
        cycle.push_str(" -> ");
        cycle.push_str(nodes[0]);
        cycles.push(cycle);
    }
    let selected = graph.files.len();
    RuleResult {
        violations: cycles,
        selected,
        ..RuleResult::ok(&rule.name, &rule.kind)
    }
}

fn no_folder_tangles(rule: &Rule, graph: &Graph) -> RuleResult {
    // Folders per project (intra-project edges only).
    let mut adjacency: HashMap<String, HashSet<String>> = HashMap::new();
    let mut folder_of: HashMap<usize, String> = HashMap::new();
    for (i, file) in graph.files.iter().enumerate() {
        folder_of.insert(i, file.folder.clone());
    }
    for &(from, to) in &graph.edges {
        // Tangles are detected within each package, never across packages.
        if graph.files[from].project != graph.files[to].project {
            continue;
        }
        let (Some(fa), Some(fb)) = (folder_of.get(&from), folder_of.get(&to)) else {
            continue;
        };
        if fa == fb {
            continue;
        }
        adjacency
            .entry(fa.clone())
            .or_default()
            .insert(fb.clone());
    }

    let mut tangles: Vec<String> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (a, targets) in &adjacency {
        for b in targets {
            let (x, y) = if a < b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
            if seen.contains(&(x.clone(), y.clone())) {
                continue;
            }
            if let Some(reverse) = adjacency.get(b)
                && reverse.contains(a)
            {
                seen.insert((x.clone(), y.clone()));
                tangles.push(format!("{x} <-> {y}"));
            }
        }
    }

    let allow: HashSet<&str> = rule.allow.iter().map(String::as_str).collect();
    let violations: Vec<String> = tangles
        .iter()
        .filter(|t| !allow.contains(t.as_str()))
        .cloned()
        .collect();
    let warnings: Vec<String> = rule
        .allow
        .iter()
        .filter(|t| !tangles.contains(t))
        .map(|t| format!("stale allow entry: {t}"))
        .collect();
    RuleResult {
        violations,
        warnings,
        selected: adjacency.len(),
        ..RuleResult::ok(&rule.name, &rule.kind)
    }
}

fn no_depend(rule: &Rule, graph: &Graph) -> RuleResult {
    let mut violations = Vec::new();
    let mut selected = 0usize;
    for &(from, to) in &graph.edges {
        let from_path = graph.files[from].path.as_str();
        let to_path = graph.files[to].path.as_str();
        if matches_any(&rule.from, from_path) {
            selected += 1;
            if matches_any(&rule.to, to_path) {
                violations.push(format!("{from_path} -> {to_path}"));
            }
        }
    }
    RuleResult {
        violations,
        selected,
        ..RuleResult::ok(&rule.name, &rule.kind)
    }
}

fn max_lines(rule: &Rule, graph: &Graph) -> RuleResult {
    let mut violations = Vec::new();
    let mut selected = 0usize;
    for file in &graph.files {
        selected += 1;
        if file.loc > rule.threshold && !matches_any(&rule.allow, &file.path) {
            violations.push(format!("{}: {} lines", file.path, file.loc));
        }
    }
    RuleResult {
        violations,
        selected,
        ..RuleResult::ok(&rule.name, &rule.kind)
    }
}

fn max_exports(rule: &Rule, graph: &Graph) -> RuleResult {
    let mut violations = Vec::new();
    let mut selected = 0usize;
    for file in &graph.files {
        selected += 1;
        if file.exports > rule.threshold && !matches_any(&rule.allow, &file.path) {
            violations.push(format!("{}: {} exports", file.path, file.exports));
        }
    }
    RuleResult {
        violations,
        selected,
        ..RuleResult::ok(&rule.name, &rule.kind)
    }
}

fn matches_any(patterns: &[String], path: &str) -> bool {
    patterns.iter().any(|pattern| glob_match(pattern, path))
}

/// Glob matching over `/`-separated relative paths. `*` matches within one
/// segment, `**` matches any number of segments (including none).
fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    glob_segments(&pattern, &path)
}

fn glob_segments(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    match pattern[0] {
        "**" => {
            glob_segments(&pattern[1..], path)
                || (!path.is_empty() && glob_segments(pattern, &path[1..]))
        }
        segment => {
            !path.is_empty()
                && segment_match(segment, path[0])
                && glob_segments(&pattern[1..], &path[1..])
        }
    }
}

fn segment_match(pattern: &str, segment: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let segment: Vec<char> = segment.chars().collect();
    segment_match_chars(&pattern, &segment)
}

fn segment_match_chars(pattern: &[char], segment: &[char]) -> bool {
    if pattern.is_empty() {
        return segment.is_empty();
    }
    match pattern[0] {
        '*' => {
            segment_match_chars(&pattern[1..], segment)
                || (!segment.is_empty() && segment_match_chars(pattern, &segment[1..]))
        }
        c => !segment.is_empty() && c == segment[0] && segment_match_chars(&pattern[1..], &segment[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_star_and_double_star() {
        assert!(glob_match("apps/web/**", "apps/web/src/model.ts"));
        assert!(glob_match("apps/web/src/**", "apps/web/src/view/icon.ts"));
        assert!(!glob_match("apps/api/**", "apps/web/src/model.ts"));
        assert!(glob_match("*.ts", "model.ts"));
        assert!(!glob_match("*.ts", "view/model.ts"));
        assert!(glob_match("apps/web/src/view/*.ts", "apps/web/src/view/icon.ts"));
    }

    #[test]
    fn folder_tangle_detects_bidirectional_pair_and_warns_when_gone() {
        // Build a tiny graph: project "p", folders p/a and p/b with edges both ways.
        let mut files = Vec::new();
        let mut index = HashMap::new();
        for (i, (path, folder)) in [
            ("a.ts", "p/a"),
            ("b.ts", "p/b"),
        ]
        .into_iter()
        .enumerate()
        {
            files.push(crate::graph::File {
                path: path.to_owned(),
                project: "p".to_owned(),
                lang: crate::graph::Lang::Ts,
                folder: folder.to_owned(),
                loc: 1,
                total_lines: 1,
                exports: 1,
            });
            index.insert(path.to_owned(), i);
        }
        let graph = Graph {
            files,
            index,
            out: vec![vec![1], vec![0]],
            edges: vec![(0, 1), (1, 0)],
        };
        let rule = Rule {
            name: "tangles".to_owned(),
            kind: "no-folder-tangles".to_owned(),
            from: vec![],
            to: vec![],
            allow: vec!["p/a <-> p/b".to_owned(), "p/a <-> p/c".to_owned()],
            threshold: 0,
        };
        let result = no_folder_tangles(&rule, &graph);
        assert!(result.violations.is_empty());
        assert_eq!(result.warnings, vec!["stale allow entry: p/a <-> p/c"]);
    }
}
