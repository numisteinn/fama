//! Per-area depth summary (used by `--stats`).

use serde::Serialize;

use crate::graph::Graph;

#[derive(Debug, Clone, Serialize)]
pub struct AreaStat {
    pub project: String,
    pub folder: String,
    pub files: usize,
    pub loc: usize,
    pub exports: usize,
    pub depth: f64,
}

/// One row per (project, folder), sorted by project then folder. `depth` is the
/// folder's total LOC over its total exports (`loc / max(1, exports)`).
pub fn area_stats(graph: &Graph) -> Vec<AreaStat> {
    let mut rows: std::collections::BTreeMap<(String, String), (usize, usize, usize)> =
        std::collections::BTreeMap::new();
    for file in &graph.files {
        let entry = rows
            .entry((file.project.clone(), file.folder.clone()))
            .or_insert((0, 0, 0));
        entry.0 += 1;
        entry.1 += file.loc;
        entry.2 += file.exports;
    }
    rows.into_iter()
        .map(|((project, folder), (files, loc, exports))| AreaStat {
            depth: loc as f64 / (exports.max(1) as f64),
            project,
            folder,
            files,
            loc,
            exports,
        })
        .collect()
}
