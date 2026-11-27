import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { run } from './index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

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
