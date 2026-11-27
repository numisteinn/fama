//! File discovery, parsing and dependency-graph construction.
//!
//! TypeScript and TSX files are parsed with `oxc_parser`. Relative imports and
//! tsconfig `paths` aliases (`~/`, `@/`, `@fama/*`) are resolved against the set
//! of discovered files. Python files are scanned with a docstring/comment-aware
//! scanner for package and relative imports, public top-level `def`/`class`,
//! and non-blank non-comment LOC. Parsing is parallelized with `rayon`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum PyImport {
    Module(String),
    From { module: String, names: Vec<String> },
}

#[derive(Clone)]
enum Imports {
    Ts(Vec<String>),
    Py(Vec<PyImport>),
}

#[derive(Clone)]
struct ParsedFile {
    path: String,
    project: String,
    lang: Lang,
    loc: usize,
    total_lines: usize,
    exports: usize,
    imports: Imports,
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
                aliases.insert(project.name.clone(), parse_aliases(root, tsconfig)?);
            }
        }
    }

    // Discover files (serial, fast), then read + parse in parallel.
    let mut jobs: Vec<(&crate::ProjectConfig, String)> = Vec::new();
    for project in &config.projects {
        let paths = if project.kind == "python" {
            discover(root, &project.source, &["py"], is_py_test)?
        } else {
            discover(root, &project.source, &["ts", "tsx"], is_ts_test)?
        };
        for path in paths {
            jobs.push((project, path));
        }
    }

    let parsed: Vec<ParsedFile> = jobs
        .par_iter()
        .map(|(project, path)| {
            let abs = root.join(path);
            let source = std::fs::read_to_string(&abs)
                .map_err(|e| format!("cannot read {path}: {e}"))?;
            if project.kind == "python" {
                let (loc, total_lines, exports, py_imports) = parse_py(&source);
                Ok(ParsedFile {
                    path: path.clone(),
                    project: project.name.clone(),
                    lang: Lang::Py,
                    loc,
                    total_lines,
                    exports,
                    imports: Imports::Py(py_imports),
                })
            } else {
                let (loc, total_lines, exports, specifiers) =
                    parse_ts(path, &source).map_err(|e| format!("cannot parse {path}: {e}"))?;
                Ok(ParsedFile {
                    path: path.clone(),
                    project: project.name.clone(),
                    lang: Lang::Ts,
                    loc,
                    total_lines,
                    exports,
                    imports: Imports::Ts(specifiers),
                })
            }
        })
        .collect::<Result<Vec<_>, String>>()?;

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
        let mut targets: Vec<usize> = Vec::new();
        match &file.imports {
            Imports::Ts(specifiers) => {
                let project_aliases = aliases.get(&file.project).cloned().unwrap_or_default();
                for spec in specifiers {
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
            }
            Imports::Py(py_imports) => {
                let project_source = sources.get(&file.project).map(String::as_str).unwrap_or("");
                for imp in py_imports {
                    for resolved in resolve_py(imp, &file.path, project_source, &file_set) {
                        if let Some(&target) = index.get(&resolved) {
                            if !targets.contains(&target) {
                                targets.push(target);
                            }
                            edge_set.insert((i, target));
                        }
                    }
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
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let abs = root.join(rel);
    if !abs.is_dir() {
        return Err(format!("source directory does not exist: {}", abs.display()));
    }
    walk_dir(&abs, rel, exts, is_test, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_dir(
    abs: &Path,
    rel: &str,
    exts: &[&str],
    is_test: fn(&str) -> bool,
    out: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(abs)
        .map_err(|e| format!("cannot read directory {}: {e}", abs.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| format!("cannot read entry in {}: {e}", abs.display()))?;
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
            walk_dir(&path, &relpath, exts, is_test, out)?;
        } else if path.is_file()
            && let Some(ext) = path.extension().and_then(|e| e.to_str())
            && exts.contains(&ext)
            && !is_test(&name)
        {
            out.push(relpath);
        }
    }
    Ok(())
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
        walk::walk_export_declaration(self, node);
    }
    fn visit_export_named_declaration(&mut self, node: &ExportNamedDeclaration<'a>) {
        self.exports += node.specifiers.len();
        walk::walk_export_named_declaration(self, node);
    }
    fn visit_export_default_declaration(&mut self, node: &ExportDefaultDeclaration<'a>) {
        self.exports += 1;
        walk::walk_export_default_declaration(self, node);
    }
    fn visit_ts_import_type(&mut self, node: &TSImportType<'a>) {
        self.specifiers
            .push(node.source.value.as_str().unwrap_or_default().to_owned());
        walk::walk_ts_import_type(self, node);
    }
    fn visit_import_expression(&mut self, node: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &node.source {
            self.specifiers
                .push(source.value.as_str().unwrap_or_default().to_owned());
        }
        walk::walk_import_expression(self, node);
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
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
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

fn parse_py(source: &str) -> (usize, usize, usize, Vec<PyImport>) {
    let loc = source
        .lines()
        .filter(|line| {
            let t = line.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .count();
    let total_lines = source.lines().count();
    let cleaned = strip_py_strings_and_comments(source);
    let exports = cleaned
        .lines()
        .filter(|line| {
            (line.starts_with("class ")
                || line.starts_with("def ")
                || line.starts_with("async def "))
                && !py_def_name(line).starts_with('_')
        })
        .count();
    (loc, total_lines, exports, python_imports(&cleaned))
}

/// Replaces Python string literals (including single/double/triple-quoted
/// strings and docstrings) and `#` comments with spaces while preserving
/// newlines so line structure and column-0 indentation remain intact.
fn strip_py_strings_and_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;

    while i < n {
        let c = chars[i];
        if c == '#' {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            let triple = i + 2 < n && chars[i + 1] == c && chars[i + 2] == c;
            if triple {
                out.push_str("   ");
                i += 3;
                while i < n {
                    if chars[i] == '\\' && i + 1 < n {
                        out.push(' ');
                        if chars[i + 1] == '\n' {
                            out.push('\n');
                        } else {
                            out.push(' ');
                        }
                        i += 2;
                    } else if chars[i] == c
                        && i + 2 < n
                        && chars[i + 1] == c
                        && chars[i + 2] == c
                    {
                        out.push_str("   ");
                        i += 3;
                        break;
                    } else {
                        if chars[i] == '\n' {
                            out.push('\n');
                        } else {
                            out.push(' ');
                        }
                        i += 1;
                    }
                }
            } else {
                out.push(' ');
                i += 1;
                while i < n {
                    if chars[i] == '\\' && i + 1 < n {
                        out.push(' ');
                        if chars[i + 1] == '\n' {
                            out.push('\n');
                        } else {
                            out.push(' ');
                        }
                        i += 2;
                    } else if chars[i] == c {
                        out.push(' ');
                        i += 1;
                        break;
                    } else if chars[i] == '\n' {
                        out.push('\n');
                        i += 1;
                        break;
                    } else {
                        out.push(' ');
                        i += 1;
                    }
                }
            }
            continue;
        }
        out.push(c);
        i += 1;
    }

    out
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

fn python_imports(cleaned: &str) -> Vec<PyImport> {
    let mut imports = Vec::new();
    for stmt in py_logical_statements(cleaned) {
        let t = stmt.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(rest) = t.strip_prefix("from ") {
            if let Some((module_part, names_part)) = split_from_import(rest) {
                let module = module_part.trim();
                if !module.is_empty() {
                    let names_trimmed = names_part
                        .trim()
                        .trim_start_matches('(')
                        .trim_end_matches(')')
                        .trim();
                    let names: Vec<String> = names_trimmed
                        .split(',')
                        .filter_map(|item| {
                            let name = item.split_whitespace().next().unwrap_or_default();
                            if name.is_empty() {
                                None
                            } else {
                                Some(name.to_owned())
                            }
                        })
                        .collect();
                    imports.push(PyImport::From {
                        module: module.to_owned(),
                        names,
                    });
                }
            }
        } else if let Some(rest) = t.strip_prefix("import ") {
            for part in rest.split(',') {
                let module = part.split_whitespace().next().unwrap_or_default();
                if !module.is_empty() {
                    imports.push(PyImport::Module(module.to_owned()));
                }
            }
        }
    }
    imports
}

fn split_from_import(rest: &str) -> Option<(&str, &str)> {
    let bytes = rest.as_bytes();
    let needle = b"import";
    if bytes.len() < needle.len() {
        return None;
    }
    for i in 0..=bytes.len() - needle.len() {
        if &bytes[i..i + needle.len()] == needle {
            let before_ok = i == 0 || bytes[i - 1].is_ascii_whitespace();
            let after_idx = i + needle.len();
            let after_ok = after_idx < bytes.len()
                && (bytes[after_idx].is_ascii_whitespace() || bytes[after_idx] == b'(');
            if before_ok && after_ok {
                return Some((&rest[..i], &rest[after_idx..]));
            }
        }
    }
    None
}

fn py_logical_statements(cleaned: &str) -> Vec<String> {
    let chars: Vec<char> = cleaned.chars().collect();
    let n = chars.len();
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut paren_depth = 0usize;
    let mut i = 0;

    while i < n {
        let c = chars[i];
        match c {
            '(' | '[' | '{' => {
                paren_depth += 1;
                current.push(c);
                i += 1;
            }
            ')' | ']' | '}' => {
                paren_depth = paren_depth.saturating_sub(1);
                current.push(c);
                i += 1;
            }
            '\\' => {
                if i + 1 < n && chars[i + 1] == '\n' {
                    current.push(' ');
                    i += 2;
                } else if i + 2 < n && chars[i + 1] == '\r' && chars[i + 2] == '\n' {
                    current.push(' ');
                    i += 3;
                } else {
                    current.push(c);
                    i += 1;
                }
            }
            '\n' => {
                if paren_depth > 0 {
                    current.push(' ');
                } else if !current.trim().is_empty() {
                    statements.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                i += 1;
            }
            ';' if paren_depth == 0 => {
                if !current.trim().is_empty() {
                    statements.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                i += 1;
            }
            _ => {
                current.push(c);
                i += 1;
            }
        }
    }
    if !current.trim().is_empty() {
        statements.push(current);
    }
    statements
}

// --- resolution ----------------------------------------------------------

fn resolve_py(
    imp: &PyImport,
    file: &str,
    project_source: &str,
    files: &HashSet<String>,
) -> Vec<String> {
    match imp {
        PyImport::Module(module) => py_candidate_bases(module, file, project_source)
            .into_iter()
            .find_map(|base| resolve_py_module(&base, files))
            .into_iter()
            .collect(),
        PyImport::From { module, names } => {
            for base in py_candidate_bases(module, file, project_source) {
                let mut resolved = Vec::new();
                let mut need_base = names.is_empty();
                for name in names {
                    if name == "*" {
                        need_base = true;
                        continue;
                    }
                    let sub = join_norm(&base, name);
                    if let Some(hit) = resolve_py_module(&sub, files) {
                        if !resolved.contains(&hit) {
                            resolved.push(hit);
                        }
                    } else {
                        need_base = true;
                    }
                }
                if need_base {
                    if let Some(hit) = resolve_py_module(&base, files) {
                        if !resolved.contains(&hit) {
                            resolved.push(hit);
                        }
                    }
                }
                if !resolved.is_empty() {
                    return resolved;
                }
            }
            Vec::new()
        }
    }
}

fn py_candidate_bases(module: &str, file: &str, project_source: &str) -> Vec<String> {
    if module.starts_with('.') {
        let dots = module.bytes().take_while(|&b| b == b'.').count();
        let rest = &module[dots..];
        let parent = parent_dir(file);
        let mut parts: Vec<&str> = parent
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let up = dots.saturating_sub(1);
        if up > parts.len() {
            return Vec::new();
        }
        parts.truncate(parts.len() - up);
        if !rest.is_empty() {
            parts.extend(rest.split('.').filter(|s| !s.is_empty()));
        }
        return vec![parts.join("/")];
    }

    let rel = module.replace('.', "/");
    let source_parent = parent_dir(project_source);
    let mut bases = vec![join_norm(&source_parent, &rel)];
    let from_source = join_norm(project_source, &rel);
    if !bases.contains(&from_source) {
        bases.push(from_source);
    }
    bases
}

fn resolve_py_module(base: &str, files: &HashSet<String>) -> Option<String> {
    let base = normalize(base);
    if base.is_empty() {
        return None;
    }
    let as_file = format!("{base}.py");
    if files.contains(&as_file) {
        return Some(as_file);
    }
    let as_pkg = format!("{base}/__init__.py");
    if files.contains(&as_pkg) {
        return Some(as_pkg);
    }
    None
}

fn join_norm(base: &str, rel: &str) -> String {
    if base.is_empty() {
        normalize(rel)
    } else if rel.is_empty() {
        normalize(base)
    } else {
        normalize(&format!("{base}/{rel}"))
    }
}

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

// --- tsconfig (JSONC + extends) ------------------------------------------

struct TsConfigResolved {
    base_url: Option<String>,
    paths: HashMap<String, String>,
}

fn parse_aliases(root: &Path, tsconfig: &str) -> Result<Vec<(String, String)>, String> {
    let mut visited = HashSet::new();
    let resolved = load_tsconfig(root, tsconfig, &mut visited)?;
    let mut out: Vec<(String, String)> = resolved.paths.into_iter().collect();
    // Longest pattern first so more specific aliases win.
    out.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

fn load_tsconfig(
    root: &Path,
    tsconfig: &str,
    visited: &mut HashSet<String>,
) -> Result<TsConfigResolved, String> {
    let norm = normalize(tsconfig);
    if !visited.insert(norm.clone()) {
        return Ok(TsConfigResolved {
            base_url: None,
            paths: HashMap::new(),
        });
    }

    let abs = root.join(&norm);
    let raw = std::fs::read_to_string(&abs)
        .map_err(|e| format!("cannot read tsconfig {}: {e}", abs.display()))?;
    let stripped = strip_jsonc(&raw);
    let value: serde_json::Value = serde_json::from_str(&stripped)
        .map_err(|e| format!("invalid tsconfig {}: {e}", abs.display()))?;

    let tsconfig_dir = parent_dir(&norm);
    let mut base_url: Option<String> = None;
    let mut paths: HashMap<String, String> = HashMap::new();

    // Follow relative `extends` (string or array of strings). External package
    // extends (e.g. "expo/tsconfig.base.json") are skipped.
    let extends_list: Vec<&str> = match &value["extends"] {
        serde_json::Value::String(s) => vec![s.as_str()],
        serde_json::Value::Array(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        _ => Vec::new(),
    };
    for ext in extends_list {
        if !ext.starts_with('.') {
            continue;
        }
        let mut parent_rel = join_norm(&tsconfig_dir, ext);
        if !root.join(&parent_rel).is_file() && !parent_rel.ends_with(".json") {
            let with_json = format!("{parent_rel}.json");
            if root.join(&with_json).is_file() {
                parent_rel = with_json;
            }
        }
        let parent = load_tsconfig(root, &parent_rel, visited)?;
        if parent.base_url.is_some() {
            base_url = parent.base_url;
        }
        paths.extend(parent.paths);
    }

    let compiler = &value["compilerOptions"];
    if let Some(local_base) = compiler["baseUrl"].as_str() {
        base_url = Some(join_norm(&tsconfig_dir, local_base));
    }
    let effective_base = base_url.clone().unwrap_or(tsconfig_dir);

    if let Some(local_paths) = compiler["paths"].as_object() {
        for (pattern, targets) in local_paths {
            let Some(target) = targets
                .as_array()
                .and_then(|t| t.first())
                .and_then(|t| t.as_str())
            else {
                continue;
            };
            let resolved = if target.starts_with('/') {
                target.to_owned()
            } else {
                join_norm(&effective_base, target)
            };
            paths.insert(pattern.clone(), resolved);
        }
    }

    Ok(TsConfigResolved { base_url, paths })
}

/// Strips `//` line comments, `/* */` block comments, and trailing commas
/// before `}` or `]` outside of JSON string literals.
fn strip_jsonc(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let n = chars.len();
    let mut no_comments = String::with_capacity(raw.len());
    let mut i = 0;

    while i < n {
        let c = chars[i];
        if c == '"' {
            no_comments.push(c);
            i += 1;
            while i < n {
                let sc = chars[i];
                no_comments.push(sc);
                if sc == '\\' && i + 1 < n {
                    no_comments.push(chars[i + 1]);
                    i += 2;
                } else if sc == '"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            i += 2;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    no_comments.push('\n');
                }
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        no_comments.push(c);
        i += 1;
    }

    // Second pass: remove trailing commas before `}` or `]` outside strings.
    let chars: Vec<char> = no_comments.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(no_comments.len());
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if c == '"' {
            out.push(c);
            i += 1;
            while i < n {
                let sc = chars[i];
                out.push(sc);
                if sc == '\\' && i + 1 < n {
                    out.push(chars[i + 1]);
                    i += 2;
                } else if sc == '"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < n && chars[j].is_whitespace() {
                j += 1;
            }
            if j < n && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
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
    fn collects_dynamic_imports_inside_exported_declarations() {
        let source = "\
export const load = () => import('./b')
export default function run() { return import('./c') }
export type T = import('./d').Thing
";
        let (_loc, _total, exports, specifiers) = parse_ts("sample.ts", source).unwrap();
        assert_eq!(exports, 3);
        assert_eq!(
            specifiers,
            vec!["./b", "./c", "./d"]
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
            resolve(
                "./view/icon",
                "apps/web/src/model.ts",
                &no_alias,
                &workspace,
                &files
            ),
            Some("apps/web/src/view/icon.ts".to_owned())
        );
        assert_eq!(
            resolve(
                "../lib",
                "apps/web/src/view/icon.ts",
                &no_alias,
                &workspace,
                &files
            ),
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
            resolve(
                "~/api",
                "apps/web/src/model.ts",
                &aliases,
                &workspace,
                &files
            ),
            Some("apps/web/src/api.ts".to_owned())
        );
        // External bare specifiers do not resolve.
        assert_eq!(
            resolve(
                "effect",
                "apps/web/src/model.ts",
                &aliases,
                &workspace,
                &files
            ),
            None
        );
    }

    #[test]
    fn resolves_workspace_package() {
        let mut files = HashSet::new();
        files.insert("packages/contracts/src/index.ts".to_owned());
        let no_alias: Vec<(String, String)> = Vec::new();
        let mut workspace = HashMap::new();
        workspace.insert(
            "@fama/contracts".to_owned(),
            "packages/contracts/src/index.ts".to_owned(),
        );
        assert_eq!(
            resolve(
                "@fama/contracts",
                "apps/web/src/model.ts",
                &no_alias,
                &workspace,
                &files
            ),
            Some("packages/contracts/src/index.ts".to_owned())
        );
    }

    #[test]
    fn scans_python_imports_multiline_and_ignores_docstrings() {
        let source = r#"
"""
Module docstring with fake defs and imports:
def ghost():
    pass
class Phantom:
    pass
import fake_module
from .ghost import nope
"""
# comment
import fama_worker.audio
from fama_worker.engines import kokoro
from . import cache
from .b import (
    foo,  # inline comment
    bar as baz,
)
from ..common import util

class Worker:
    '''
def inside_docstring():
    pass
    '''
    pass

def run():
    pass

async def _private():
    pass
"#;
        let (_loc, _total, exports, imports) = parse_py(source);
        assert_eq!(exports, 2); // Worker, run (not ghost, Phantom, inside_docstring, _private)
        assert_eq!(
            imports,
            vec![
                PyImport::Module("fama_worker.audio".to_owned()),
                PyImport::From {
                    module: "fama_worker.engines".to_owned(),
                    names: vec!["kokoro".to_owned()],
                },
                PyImport::From {
                    module: ".".to_owned(),
                    names: vec!["cache".to_owned()],
                },
                PyImport::From {
                    module: ".b".to_owned(),
                    names: vec!["foo".to_owned(), "bar".to_owned()],
                },
                PyImport::From {
                    module: "..common".to_owned(),
                    names: vec!["util".to_owned()],
                },
            ]
        );
    }

    #[test]
    fn resolves_python_package_and_relative_imports() {
        let files: HashSet<String> = [
            "worker/src/fama_worker/__init__.py",
            "worker/src/fama_worker/a.py",
            "worker/src/fama_worker/b.py",
            "worker/src/fama_worker/common.py",
            "worker/src/fama_worker/extract/__init__.py",
            "worker/src/fama_worker/extract/web.py",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let src = "worker/src/fama_worker";

        // Absolute `import fama_worker.a`
        assert_eq!(
            resolve_py(
                &PyImport::Module("fama_worker.a".to_owned()),
                "worker/src/fama_worker/b.py",
                src,
                &files
            ),
            vec!["worker/src/fama_worker/a.py"]
        );

        // Relative `from .b import foo`
        assert_eq!(
            resolve_py(
                &PyImport::From {
                    module: ".b".to_owned(),
                    names: vec!["foo".to_owned()],
                },
                "worker/src/fama_worker/a.py",
                src,
                &files
            ),
            vec!["worker/src/fama_worker/b.py"]
        );

        // Package submodule `from fama_worker.extract import web`
        assert_eq!(
            resolve_py(
                &PyImport::From {
                    module: "fama_worker.extract".to_owned(),
                    names: vec!["web".to_owned()],
                },
                "worker/src/fama_worker/extract/__init__.py",
                src,
                &files
            ),
            vec!["worker/src/fama_worker/extract/web.py"]
        );

        // Parent relative `from ..common import util`
        assert_eq!(
            resolve_py(
                &PyImport::From {
                    module: "..common".to_owned(),
                    names: vec!["util".to_owned()],
                },
                "worker/src/fama_worker/extract/web.py",
                src,
                &files
            ),
            vec!["worker/src/fama_worker/common.py"]
        );

        // Package `__init__.py` target `from fama_worker.extract import extract`
        assert_eq!(
            resolve_py(
                &PyImport::From {
                    module: "fama_worker.extract".to_owned(),
                    names: vec!["extract".to_owned()],
                },
                "worker/src/fama_worker/a.py",
                src,
                &files
            ),
            vec!["worker/src/fama_worker/extract/__init__.py"]
        );
    }

    #[test]
    fn parses_jsonc_tsconfig_with_comments_trailing_commas_and_extends() {
        let dir = std::env::temp_dir().join(format!(
            "arch_check_tsconfig_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("apps/web")).unwrap();
        std::fs::write(
            dir.join("tsconfig.base.json"),
            r#"{
                // Base config comment
                "compilerOptions": {
                    /* block comment */
                    "paths": {
                        "@shared/*": ["./shared/*"],
                    },
                },
            }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("apps/web/tsconfig.json"),
            r#"{
                "extends": "../../tsconfig.base.json",
                "compilerOptions": {
                    "paths": {
                        "~/*": ["./src/*"], // inline comment with http://example.com
                    },
                },
            }"#,
        )
        .unwrap();

        let aliases = parse_aliases(&dir, "apps/web/tsconfig.json").unwrap();
        assert!(aliases.contains(&("@shared/*".to_owned(), "shared/*".to_owned())));
        assert!(aliases.contains(&("~/*".to_owned(), "apps/web/src/*".to_owned())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_source_directory_returns_error() {
        let dir = std::env::temp_dir().join(format!(
            "arch_check_missing_dir_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            projects: vec![crate::ProjectConfig {
                name: "web".to_owned(),
                kind: "ts".to_owned(),
                source: "does/not/exist".to_owned(),
                tsconfig: None,
            }],
            workspace: HashMap::new(),
            rules: vec![],
        };
        let err = build(&dir, &config).err().expect("expected error for missing source dir");
        assert!(err.contains("does not exist"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalizes_dot_segments() {
        assert_eq!(
            normalize("apps/web/src/./view/../view/icon"),
            "apps/web/src/view/icon"
        );
        assert_eq!(normalize("a/../../b"), "b");
    }
}
