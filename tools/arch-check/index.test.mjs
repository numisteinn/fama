import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { run } from './index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

function withTempFixture(fn) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'arch-check-test-'))
    try {
        return fn(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test('the prebuilt binary matches the committed source hash', () => {
    const result = spawnSync('./source-hash.sh', ['--check'], {
        cwd: here,
        encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
})

test('the binary runs end-to-end and reports clean rules', () => {
    const { status, stdout, stderr } = run(['--json'], { cwd: repoRoot, capture: true })
    assert.equal(status, 0, stderr)
    const report = JSON.parse(stdout)
    assert.ok(report.files > 0, 'expected at least one file')
    assert.ok(report.rules.length > 0, 'expected at least one rule')

    const cycles = report.rules.find(rule => rule.kind === 'no-file-cycles')
    assert.ok(cycles, 'expected a no-file-cycles rule')
    assert.deepEqual(cycles.violations, [], 'no-file-cycles must have zero violations')

    for (const rule of report.rules) {
        assert.deepEqual(
            rule.violations,
            [],
            `rule ${rule.name} must have zero violations on main`
        )
    }
})

test('the binary accepts --stats', () => {
    const { status, stdout, stderr } = run(['--json', '--stats'], { cwd: repoRoot, capture: true })
    assert.equal(status, 0, stderr)
    const report = JSON.parse(stdout)
    assert.ok(Array.isArray(report.stats), 'expected a stats array')
    assert.ok(report.stats.length > 0, 'expected at least one area')
})

test('detects Python relative and package cycles through the CLI', () => {
    withTempFixture(dir => {
        const pkg = path.join(dir, 'worker/src/fama_worker')
        mkdirSync(pkg, { recursive: true })
        writeFileSync(path.join(pkg, '__init__.py'), '')
        writeFileSync(
            path.join(pkg, 'a.py'),
            'from .b import (\n    helper,\n)\n\ndef entry():\n    return helper()\n'
        )
        writeFileSync(
            path.join(pkg, 'b.py'),
            'import fama_worker.a\n\ndef helper():\n    return fama_worker.a\n'
        )
        const configPath = path.join(dir, 'custom.config.json')
        writeFileSync(
            configPath,
            JSON.stringify({
                projects: [{ name: 'worker', kind: 'python', source: 'worker/src/fama_worker' }],
                rules: [{ name: 'no-file-cycles', kind: 'no-file-cycles' }]
            })
        )

        // Also verifies --config works when cwd does not contain arch.config.json.
        const { status, stdout, stderr } = run(['--config', configPath, '--json'], {
            cwd: os.tmpdir(),
            capture: true
        })
        assert.equal(status, 1, `expected cycle failure, stderr=${stderr}`)
        const report = JSON.parse(stdout)
        const cycles = report.rules.find(rule => rule.kind === 'no-file-cycles')
        assert.equal(cycles.violations.length, 1)
        assert.equal(
            cycles.violations[0],
            'worker/src/fama_worker/a.py -> worker/src/fama_worker/b.py -> worker/src/fama_worker/a.py'
        )
    })
})

test('detects TypeScript dynamic imports inside exported declarations', () => {
    withTempFixture(dir => {
        const src = path.join(dir, 'src')
        mkdirSync(src, { recursive: true })
        writeFileSync(path.join(src, 'a.ts'), "export const load = () => import('./b')\n")
        writeFileSync(path.join(src, 'b.ts'), "export { load } from './a'\n")
        writeFileSync(
            path.join(dir, 'arch.config.json'),
            JSON.stringify({
                projects: [{ name: 'app', kind: 'ts', source: 'src' }],
                rules: [{ name: 'no-file-cycles', kind: 'no-file-cycles' }]
            })
        )

        const { status, stdout } = run(['--json'], { cwd: dir, capture: true })
        assert.equal(status, 1)
        const report = JSON.parse(stdout)
        const cycles = report.rules.find(rule => rule.kind === 'no-file-cycles')
        assert.deepEqual(cycles.violations, ['src/a.ts -> src/b.ts -> src/a.ts'])
    })
})

test('fails fast when a configured source directory is missing', () => {
    withTempFixture(dir => {
        writeFileSync(
            path.join(dir, 'arch.config.json'),
            JSON.stringify({
                projects: [{ name: 'missing', kind: 'ts', source: 'nope/src' }],
                rules: [{ name: 'no-file-cycles', kind: 'no-file-cycles' }]
            })
        )
        const { status, stderr } = run([], { cwd: dir, capture: true })
        assert.equal(status, 1)
        assert.match(stderr, /does not exist/)
    })
})

test('does not confuse stdlib imports with sibling Python modules and catches one-line suite cycles', () => {
    withTempFixture(dir => {
        const pkg = path.join(dir, 'worker/src/fama_worker')
        mkdirSync(pkg, { recursive: true })
        writeFileSync(path.join(pkg, '__init__.py'), '')
        writeFileSync(path.join(pkg, 'a.py'), 'import logging\n')
        writeFileSync(path.join(pkg, 'logging.py'), 'import fama_worker.a\n')
        writeFileSync(
            path.join(dir, 'arch.config.json'),
            JSON.stringify({
                projects: [{ name: 'worker', kind: 'python', source: 'worker/src/fama_worker' }],
                rules: [{ name: 'no-file-cycles', kind: 'no-file-cycles' }]
            })
        )

        // Stdlib `import logging` must NOT form a cycle with sibling `logging.py`.
        const clean = run(['--json'], { cwd: dir, capture: true })
        assert.equal(clean.status, 0, clean.stderr)

        // One-line suite `if True: import fama_worker.logging` MUST form a cycle.
        writeFileSync(path.join(pkg, 'a.py'), 'if True: import fama_worker.logging\n')
        const cyclic = run(['--json'], { cwd: dir, capture: true })
        assert.equal(cyclic.status, 1, cyclic.stderr)
        const report = JSON.parse(cyclic.stdout)
        const cycles = report.rules.find(rule => rule.kind === 'no-file-cycles')
        assert.deepEqual(cycles.violations, [
            'worker/src/fama_worker/a.py -> worker/src/fama_worker/logging.py -> worker/src/fama_worker/a.py'
        ])

        // One-line suite with walrus operator `:=` MUST also form a cycle.
        writeFileSync(path.join(pkg, 'a.py'), 'if enabled := True: import fama_worker.logging\n')
        const walrus = run(['--json'], { cwd: dir, capture: true })
        assert.equal(walrus.status, 1, walrus.stderr)
        const walrusReport = JSON.parse(walrus.stdout)
        const walrusCycles = walrusReport.rules.find(rule => rule.kind === 'no-file-cycles')
        assert.deepEqual(walrusCycles.violations, [
            'worker/src/fama_worker/a.py -> worker/src/fama_worker/logging.py -> worker/src/fama_worker/a.py'
        ])

        // One-line suite with Unicode identifier (including combining marks) containing `lambda`.
        for (const stmt of [
            'if λlambda := True: import fama_worker.logging\n',
            'if a\u0301lambda := True: import fama_worker.logging\n'
        ]) {
            writeFileSync(path.join(pkg, 'a.py'), stmt)
            const unicode = run(['--json'], { cwd: dir, capture: true })
            assert.equal(unicode.status, 1, unicode.stderr)
            const unicodeReport = JSON.parse(unicode.stdout)
            const unicodeCycles = unicodeReport.rules.find(rule => rule.kind === 'no-file-cycles')
            assert.deepEqual(unicodeCycles.violations, [
                'worker/src/fama_worker/a.py -> worker/src/fama_worker/logging.py -> worker/src/fama_worker/a.py'
            ])
        }
    })
})

test('run() supports a relative cwd without duplicating it', () => {
    withTempFixture(dir => {
        const sub = path.join(dir, 'sub')
        const src = path.join(sub, 'src')
        mkdirSync(src, { recursive: true })
        writeFileSync(path.join(src, 'index.ts'), 'export const x = 1\n')
        writeFileSync(
            path.join(sub, 'arch.config.json'),
            JSON.stringify({
                projects: [{ name: 'app', kind: 'ts', source: 'src' }],
                rules: [{ name: 'no-file-cycles', kind: 'no-file-cycles' }]
            })
        )
        const rel = path.relative(process.cwd(), sub)
        const { status, stderr } = run(['--json'], { cwd: rel, capture: true })
        assert.equal(status, 0, stderr)
    })
})
