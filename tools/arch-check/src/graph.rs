//! File discovery, parsing and dependency-graph construction.
//!
//! TypeScript and TSX files are parsed with `oxc_parser`. Relative imports and
//! tsconfig `paths` aliases (`~/`, `@/`, `@fama/*`) are resolved against the set
//! of discovered files. Python files are scanned with a fast line-based parser
//! for `fama_worker.*` / relative imports, public top-level `def`/`class`, and
//! non-blank non-comment LOC. Parsing is parallelized with `rayon`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::SourceType;
use rayon::prelude::*;

use crate::Config;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ts,
    Py,
}

#[derive(Debug, Clone)]
pub struct File {
    pub path: String,
    pub project: String,
    pub lang: Lang,
    pub folder: String,
    pub loc: usize,
    pub total_lines: usize,
    pub exports: usize,
}

#[derive(Clone)]
struct ParsedFile {
    path: String,
    project: String,
    lang: Lang,
    loc: usize,
    total_lines: usize,
    exports: usize,
    specifiers: Vec<String>,
}

pub struct Graph {
    pub files: Vec<File>,
    pub index: HashMap<String, usize>,
    pub out: Vec<Vec<usize>>,
    pub edges: Vec<(usize, usize)>,
}

impl Graph {
    pub fn fan_out(&self, i: usize) -> usize {
        self.out[i].len()
    }
}

pub fn build(root: &Path, config: &Config) -> Result<Graph, String> {
    // tsconfig path aliases per TS project.
    let mut aliases: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut sources: HashMap<String, String> = HashMap::new();
    for project in &config.projects {
        sources.insert(project.name.clone(), project.source.clone());
        if project.kind == "ts" {
            if let Some(tsconfig) = &project.tsconfig {
                aliases.insert(project.name.clone(), parse_aliases(root, tsconfig));
            }
        }
    }

    // Discover files (serial, fast), then read + parse in parallel.
    let mut jobs: Vec<(&crate::ProjectConfig, String)> = Vec::new();
    for project in &config.projects {
        let paths = if project.kind == "python" {
            discover(root, &project.source, &["py"], is_py_test)
        } else {
            discover(root, &project.source, &["ts", "tsx"], is_ts_test)
        };
        for path in paths {
            jobs.push((project, path));
        }
    }

    let parsed: Vec<ParsedFile> = jobs
        .par_iter()
        .filter_map(|(project, path)| {
            let abs = root.join(path);
            let source = std::fs::read_to_string(&abs).ok()?;
            if project.kind == "python" {
                let (loc, total_lines, exports, specifiers) = parse_py(&source);
                Some(ParsedFile {
                    path: path.clone(),
                    project: project.name.clone(),
                    lang: Lang::Py,
                    loc,
                    total_lines,
                    exports,
                    specifiers,
                })
            } else {
                match parse_ts(path, &source) {
                    Ok((loc, total_lines, exports, specifiers)) => Some(ParsedFile {
                        path: path.clone(),
                        project: project.name.clone(),
                        lang: Lang::Ts,
                        loc,
                        total_lines,
                        exports,
                        specifiers,
                    }),
                    Err(message) => {
                        eprintln!("arch-check: skipping {path}: {message}");
                        None
                    }
                }
            }
        })
        .collect();

    let mut index = HashMap::new();
    let file_set: HashSet<String> = parsed.iter().map(|f| f.path.clone()).collect();
    for (i, file) in parsed.iter().enumerate() {
        index.insert(file.path.clone(), i);
    }

    let files: Vec<File> = parsed
        .iter()
        .map(|file| {
            let source = sources.get(&file.project).map(String::as_str).unwrap_or("");
            File {
                path: file.path.clone(),
                project: file.project.clone(),
                lang: file.lang,
                folder: folder_key(&file.project, &file.path, source),
                loc: file.loc,
                total_lines: file.total_lines,
                exports: file.exports,
            }
        })
        .collect();

    let mut out: Vec<Vec<usize>> = vec![Vec::new(); parsed.len()];
    let mut edge_set: HashSet<(usize, usize)> = HashSet::new();
    for (i, file) in parsed.iter().enumerate() {
        let project_aliases = aliases.get(&file.project).cloned().unwrap_or_default();
        let mut targets: Vec<usize> = Vec::new();
        for spec in &file.specifiers {
            if let Some(resolved) =
                resolve(spec, &file.path, &project_aliases, &config.workspace, &file_set)
            {
                if let Some(&target) = index.get(&resolved) {
                    if !targets.contains(&target) {
                        targets.push(target);
                    }
                    edge_set.insert((i, target));
                }
            }
        }
        out[i] = targets;
    }

    let mut edges: Vec<(usize, usize)> = edge_set.into_iter().collect();
    edges.sort_unstable();

    Ok(Graph {
        files,
        index,
        out,
        edges,
    })
}

// --- discovery -----------------------------------------------------------

fn discover(
    root: &Path,
    rel: &str,
    exts: &[&str],
    is_test: fn(&str) -> bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let abs = root.join(rel);
    walk_dir(&abs, rel, exts, is_test, &mut out);
    out.sort();
    out
}

fn walk_dir(
    abs: &Path,
    rel: &str,
    exts: &[&str],
    is_test: fn(&str) -> bool,
    out: &mut Vec<String>,
) {
    let Ok(entries) = std::fs::read_dir(abs) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let relpath = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, &relpath, exts, is_test, out);
        } else if path.is_file()
            && let Some(ext) = path.extension().and_then(|e| e.to_str())
            && exts.contains(&ext)
            && !is_test(&name)
        {
            out.push(relpath);
        }
    }
}

fn is_ts_test(name: &str) -> bool {
    name.ends_with(".test.ts")
        || name.ends_with(".test.tsx")
        || name.ends_with(".spec.ts")
        || name.ends_with(".spec.tsx")
        || name == "vitest-setup.ts"
}

fn is_py_test(name: &str) -> bool {
    name.starts_with("test_") || name.ends_with("_test.py")
}

// --- TypeScript parsing --------------------------------------------------

struct TsCollector<'a> {
    specifiers: Vec<String>,
    exports: usize,
    phantom: std::marker::PhantomData<&'a ()>,
}

impl<'a> Visit<'a> for TsCollector<'a> {
    fn visit_import_declaration(&mut self, node: &ImportDeclaration<'a>) {
        self.specifiers
            .push(node.source.value.as_str().unwrap_or_default().to_owned());
    }
    fn visit_export_from_declaration(&mut self, node: &ExportFromDeclaration<'a>) {
        self.specifiers
            .push(node.source.value.as_str().unwrap_or_default().to_owned());
        self.exports += node.specifiers.len();
    }
    fn visit_export_all_declaration(&mut self, node: &ExportAllDeclaration<'a>) {
        self.specifiers
            .push(node.source.value.as_str().unwrap_or_default().to_owned());
        self.exports += 1;
    }
    fn visit_export_declaration(&mut self, node: &ExportDeclaration<'a>) {
        self.exports += declaration_count(&node.declaration);
    }
    fn visit_export_named_declaration(&mut self, node: &ExportNamedDeclaration<'a>) {
        self.exports += node.specifiers.len();
    }
    fn visit_export_default_declaration(&mut self, _node: &ExportDefaultDeclaration<'a>) {
        self.exports += 1;
    }
    fn visit_ts_import_type(&mut self, node: &TSImportType<'a>) {
        self.specifiers
            .push(node.source.value.as_str().unwrap_or_default().to_owned());
    }
    fn visit_import_expression(&mut self, node: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &node.source {
            self.specifiers
                .push(source.value.as_str().unwrap_or_default().to_owned());
        }
    }
    fn visit_ts_external_module_reference(&mut self, node: &TSExternalModuleReference<'a>) {
        self.specifiers
            .push(node.expression.value.as_str().unwrap_or_default().to_owned());
    }
}

fn declaration_count(decl: &Declaration) -> usize {
    match decl {
        Declaration::VariableDeclaration(v) => v.declarations.len(),
        _ => 1,
    }
}

fn parse_ts(path: &str, source: &str) -> Result<(usize, usize, usize, Vec<String>), String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| e.to_string())?;
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.fatal_error {
        return Err(format!("{:?}", parsed.diagnostics));
    }
    let mut collector = TsCollector {
        specifiers: Vec::new(),
        exports: 0,
        phantom: std::marker::PhantomData,
    };
    collector.visit_program(&parsed.program);
    Ok((
        count_loc(source),
        source.lines().count(),
        collector.exports,
        collector.specifiers,
    ))
}

fn count_loc(source: &str) -> usize {
    source
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty()
                && !line.starts_with("//")
                && !line.starts_with("/*")
                && !line.starts_with('*')
        })
        .count()
}

// --- Python scanning -----------------------------------------------------

fn parse_py(source: &str) -> (usize, usize, usize, Vec<String>) {
    let loc = source
        .lines()
        .filter(|line| {
            let t = line.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .count();
    let total_lines = source.lines().count();
    let exports = source
        .lines()
        .filter(|line| {
            (line.starts_with("class ")
                || line.starts_with("def ")
                || line.starts_with("async def "))
                && !py_def_name(line).starts_with('_')
        })
        .count();
    (loc, total_lines, exports, python_imports(source))
}

fn py_def_name(line: &str) -> &str {
    let rest = line
        .strip_prefix("async def ")
        .or_else(|| line.strip_prefix("class "))
        .or_else(|| line.strip_prefix("def "))
        .unwrap_or_default();
    rest.split(|c: char| c == '(' || c == ':' || c.is_whitespace())
        .next()
        .unwrap_or_default()
}

fn python_imports(source: &str) -> Vec<String> {
    let mut mods = Vec::new();
    for line in source.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            continue;
        }
        if let Some(rest) = t.strip_prefix("from ") {
            if let Some(idx) = rest.find(" import") {
                let module = rest[..idx].trim();
                if !module.is_empty() {
                    mods.push(module.to_owned());
                }
            }
        } else if let Some(rest) = t.strip_prefix("import ") {
            for part in rest.split(',') {
                let module = part.split(" as ").next().unwrap_or_default().trim();
                if !module.is_empty() {
                    mods.push(module.to_owned());
                }
            }
        }
    }
    mods
}

// --- resolution ----------------------------------------------------------

fn resolve(
    spec: &str,
    file: &str,
    aliases: &[(String, String)],
    workspace: &HashMap<String, String>,
    files: &HashSet<String>,
) -> Option<String> {
    // Workspace packages (e.g. "@fama/contracts").
    for (key, value) in workspace {
        if spec == key {
            return resolve_file(value, files);
        }
        if let Some(sub) = spec.strip_prefix(&format!("{key}/")) {
            let candidate = normalize(&format!("{value}/{sub}"));
            if let Some(resolved) = resolve_file(&candidate, files) {
                return Some(resolved);
            }
        }
    }

    // Relative imports.
    if spec.starts_with('.') {
        let dir = parent_dir(file);
        let candidate = normalize(&format!("{dir}/{spec}"));
        return resolve_file(&candidate, files);
    }

    // tsconfig `paths` aliases, longest prefix first.
    let mut best: Option<String> = None;
    let mut best_len = 0usize;
    for (pattern, target) in aliases {
        if let Some(candidate) = apply_alias(pattern, target, spec) {
            if pattern.len() > best_len {
                best_len = pattern.len();
                best = Some(candidate);
            }
        }
    }
    best.and_then(|candidate| resolve_file(&candidate, files))
}

fn apply_alias(pattern: &str, target: &str, spec: &str) -> Option<String> {
    if let Some(star) = pattern.find('*') {
        let prefix = &pattern[..star];
        let suffix = &pattern[star + 1..];
        if spec.starts_with(prefix)
            && spec.ends_with(suffix)
            && spec.len() >= prefix.len() + suffix.len()
        {
            let wildcard = &spec[prefix.len()..spec.len() - suffix.len()];
            return Some(target.replacen('*', wildcard, 1));
        }
        None
    } else if spec == pattern {
        Some(target.to_owned())
    } else {
        None
    }
}

fn resolve_file(candidate: &str, files: &HashSet<String>) -> Option<String> {
    let candidate = normalize(candidate);
    if files.contains(&candidate) {
        return Some(candidate);
    }
    for ext in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
        let with_ext = format!("{candidate}{ext}");
        if files.contains(&with_ext) {
            return Some(with_ext);
        }
    }
    for index in ["index.ts", "index.tsx", "index.js"] {
        let with_index = format!("{candidate}/{index}");
        if files.contains(&with_index) {
            return Some(with_index);
        }
    }
    None
}

fn parse_aliases(root: &Path, tsconfig: &str) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(root.join(tsconfig)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let compiler = &value["compilerOptions"];
    let tsconfig_dir = parent_dir(tsconfig);
    let base = match compiler["baseUrl"].as_str() {
        Some(base_url) => normalize(&format!("{tsconfig_dir}/{base_url}")),
        None => tsconfig_dir,
    };
    let mut out = Vec::new();
    if let Some(paths) = compiler["paths"].as_object() {
        for (pattern, targets) in paths {
            let Some(target) = targets.as_array().and_then(|t| t.first()).and_then(|t| t.as_str())
            else {
                continue;
            };
            let resolved = if target.starts_with('.') {
                normalize(&format!("{base}/{target}"))
            } else {
                target.to_owned()
            };
            out.push((pattern.clone(), resolved));
        }
    }
    // Longest pattern first so more specific aliases win.
    out.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    out
}

// --- path helpers --------------------------------------------------------

fn folder_key(project: &str, path: &str, source: &str) -> String {
    let prefix = format!("{source}/");
    let rel = path.strip_prefix(&prefix).unwrap_or(path);
    let folder = if rel.contains('/') {
        rel.split('/').next().unwrap_or_default()
    } else {
        "<root>"
    };
    format!("{project}/{folder}")
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_owned(),
        None => String::new(),
    }
}

fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    out.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_ts_loc_exports_and_specifiers() {
        let source = "// comment\nimport { a } from './a'\nimport type { T } from './types'\nexport const x = 1, y = 2\nexport function f() {}\nexport default class C {}\nexport { a }\nexport * from './everything'\nconst hidden = 1\n";
        let (loc, total, exports, specifiers) = parse_ts("sample.ts", source).unwrap();
        assert_eq!(loc, 8);
        assert_eq!(total, 9);
        // x, y (2) + f (1) + default C (1) + {a} (1) + export * (1)
        assert_eq!(exports, 6);
        assert_eq!(
            specifiers,
            vec!["./a", "./types", "./everything"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn resolves_relative_and_extension_and_index() {
        let mut files = HashSet::new();
        files.insert("apps/web/src/view/icon.ts".to_owned());
        files.insert("apps/web/src/lib/index.ts".to_owned());
        let no_alias: Vec<(String, String)> = Vec::new();
        let workspace = HashMap::new();
        assert_eq!(
            resolve("./view/icon", "apps/web/src/model.ts", &no_alias, &workspace, &files),
            Some("apps/web/src/view/icon.ts".to_owned())
        );
        assert_eq!(
            resolve("../lib", "apps/web/src/view/icon.ts", &no_alias, &workspace, &files),
            Some("apps/web/src/lib/index.ts".to_owned())
        );
    }

    #[test]
    fn resolves_tsconfig_alias() {
        let mut files = HashSet::new();
        files.insert("apps/web/src/api.ts".to_owned());
        let aliases = vec![("~/*".to_owned(), "apps/web/src/*".to_owned())];
        let workspace = HashMap::new();
        assert_eq!(
            resolve("~/api", "apps/web/src/model.ts", &aliases, &workspace, &files),
            Some("apps/web/src/api.ts".to_owned())
        );
        // External bare specifiers do not resolve.
        assert_eq!(
            resolve("effect", "apps/web/src/model.ts", &aliases, &workspace, &files),
            None
        );
    }

    #[test]
    fn resolves_workspace_package() {
        let mut files = HashSet::new();
        files.insert("packages/contracts/src/index.ts".to_owned());
        let no_alias: Vec<(String, String)> = Vec::new();
        let mut workspace = HashMap::new();
        workspace.insert("@fama/contracts".to_owned(), "packages/contracts/src/index.ts".to_owned());
        assert_eq!(
            resolve("@fama/contracts", "apps/web/src/model.ts", &no_alias, &workspace, &files),
            Some("packages/contracts/src/index.ts".to_owned())
        );
    }

    #[test]
    fn scans_python_imports_and_exports() {
        let source = "# comment\nimport fama_worker.audio\nfrom fama_worker.engines import kokoro\nfrom . import cache\nfrom ..common import util\n\nclass Worker:\n    pass\n\ndef run():\n    pass\n\nasync def _private():\n    pass\n\ndef _helper():\n    pass\n";
        let (loc, _total, exports, imports) = parse_py(source);
        assert_eq!(loc, 12);
        assert_eq!(exports, 2); // Worker, run (not _private, _helper)
        assert_eq!(
            imports,
            vec![
                "fama_worker.audio",
                "fama_worker.engines",
                ".",
                "..common"
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn normalizes_dot_segments() {
        assert_eq!(normalize("apps/web/src/./view/../view/icon"), "apps/web/src/view/icon");
        assert_eq!(normalize("a/../../b"), "b");
    }
}
