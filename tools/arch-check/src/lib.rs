//! A fast, standalone architecture checker for the Fama polyglot repo.
//!
//! Parses the TypeScript (apps + packages) and Python (worker) source in
//! parallel, builds a file-level dependency graph, and evaluates declarative
//! rules from `arch.config.json`.

mod cycles;
mod graph;
mod metrics;
mod rules;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub use graph::Graph;
pub use rules::{Rule, RuleResult};

#[derive(Deserialize)]
pub struct Config {
    pub projects: Vec<ProjectConfig>,
    #[serde(default)]
    pub workspace: HashMap<String, String>,
    pub rules: Vec<Rule>,
}

#[derive(Deserialize)]
pub struct ProjectConfig {
    pub name: String,
    /// `"ts"` or `"python"`.
    pub kind: String,
    /// Repository-relative source directory to scan.
    pub source: String,
    #[serde(default)]
    pub tsconfig: Option<String>,
}

#[derive(Serialize)]
pub struct Report {
    pub files: usize,
    pub rules: Vec<RuleResult>,
    pub time_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<Vec<metrics::AreaStat>>,
}

pub fn run_cli(args: Vec<String>) -> i32 {
    let mut config_path = PathBuf::from("arch.config.json");
    let mut json = false;
    let mut stats = false;
    let mut it = args.into_iter().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--config" => match it.next() {
                Some(value) => config_path = PathBuf::from(value),
                None => {
                    eprintln!("--config needs a path");
                    return 2;
                }
            },
            "--json" => json = true,
            "--stats" => stats = true,
            "--help" | "-h" => {
                print_help();
                return 0;
            }
            other => {
                eprintln!("arch-check: unknown argument: {other}");
                print_help();
                return 2;
            }
        }
    }
    match run(&config_path, json, stats) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("arch-check: {message}");
            1
        }
    }
}

fn print_help() {
    println!(
        "arch-check — Fama architecture checker\n\n\
         USAGE:\n    \
         arch-check [--config <path>] [--json] [--stats]\n\n\
         OPTIONS:\n    \
         --config <path>  read a config file (default: ./arch.config.json)\n    \
         --json           emit a JSON report\n    \
         --stats          include the per-area depth summary"
    );
}

fn run(config_path: &Path, json: bool, stats: bool) -> Result<i32, String> {
    let root = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let raw = std::fs::read_to_string(config_path)
        .map_err(|e| format!("cannot read {}: {e}", config_path.display()))?;
    let config: Config =
        serde_json::from_str(&raw).map_err(|e| format!("invalid config: {e}"))?;

    let started = Instant::now();
    let graph = graph::build(&root, &config)?;

    let mut results = Vec::new();
    let mut total_violations = 0usize;
    for rule in &config.rules {
        let rule_started = Instant::now();
        let mut result = rules::evaluate_one(rule, &graph)?;
        result.time_ms = rule_started.elapsed().as_secs_f64() * 1000.0;
        total_violations += result.violations.len();
        results.push(result);
    }

    let report = Report {
        files: graph.files.len(),
        rules: results,
        time_ms: started.elapsed().as_secs_f64() * 1000.0,
        stats: if stats {
            Some(metrics::area_stats(&graph))
        } else {
            None
        },
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
    } else {
        print_human(&report, stats);
    }
    Ok(if total_violations == 0 { 0 } else { 1 })
}

fn print_human(report: &Report, with_stats: bool) {
    let violations = report.rules.iter().map(|r| r.violations.len()).sum::<usize>();
    println!(
        "arch-check — {} files, {} rules, {} violations",
        report.files,
        report.rules.len(),
        violations
    );
    println!();

    for rule in &report.rules {
        let mark = if rule.violations.is_empty() { "✓" } else { "✗" };
        println!(
            "{mark} {:<24} {:>4} violation{}   ({:.1} ms)",
            rule.name,
            rule.violations.len(),
            if rule.violations.len() == 1 { "" } else { "s" },
            rule.time_ms
        );
        for violation in &rule.violations {
            println!("      {violation}");
        }
        for warning in &rule.warnings {
            println!("  ⚠   {warning}");
        }
    }

    if with_stats {
        if let Some(stats) = &report.stats {
            println!();
            println!("per-area depth (depth = loc / exports)");
            let mut last_project = String::new();
            for row in stats {
                if row.project != last_project {
                    println!("  {}", row.project);
                    last_project = row.project.clone();
                }
                let folder = row
                    .folder
                    .rsplit_once('/')
                    .map(|(_, name)| name)
                    .unwrap_or(&row.folder);
                println!(
                    "    {:<12} {:>3} files  {:>5} loc  {:>4} exports  depth {:.1}",
                    folder, row.files, row.loc, row.exports, row.depth
                );
            }
        }
    }

    println!();
    println!("{violations} violations · {:.1} ms", report.time_ms);
}
