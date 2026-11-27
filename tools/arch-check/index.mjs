import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const binaryName = {
    'darwin-arm64': 'arch-check-darwin-arm64',
    'linux-x64': 'arch-check-linux-x64'
}[`${process.platform}-${process.arch}`]

/**
 * Runs the arch-check binary against the config at `root/arch.config.json`.
 * Returns `{ status, stdout, stderr }`. With `capture`, output is captured;
 * otherwise it streams to the process stdio.
 */
export function run(args = [], { cwd = process.cwd(), capture = false } = {}) {
    if (!binaryName) {
        throw new Error(
            `No arch-check binary for ${process.platform}-${process.arch}. ` +
                'Build one with tools/arch-check/build.sh, or run on macOS arm64 or Linux x64.'
        )
    }
    const binary = path.join(here, 'bin', binaryName)
    if (!existsSync(binary)) {
        throw new Error(`Missing ${binary}. Run tools/arch-check/build.sh and commit bin/.`)
    }
    const config = path.join(cwd, 'arch.config.json')
    if (!existsSync(config)) {
        throw new Error(`No arch.config.json at ${config}.`)
    }
    const result = spawnSync(binary, ['--config', config, ...args], {
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        maxBuffer: 64 * 1024 * 1024
    })
    if (result.error) {
        throw result.error
    }
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    const { status } = run(process.argv.slice(2))
    process.exit(status ?? 1)
}
