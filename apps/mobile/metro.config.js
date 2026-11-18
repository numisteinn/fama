const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
// @fama/contracts ships TypeScript source from the workspace.
config.watchFolders = [...new Set([...(config.watchFolders ?? []), path.resolve(__dirname, "../..")])]

module.exports = config
