"use strict"

// expo-sharing names its extension target "expo-sharing-extension". Show the app name in the share sheet.
// Mods run in reverse order, so register this before expo-sharing to run after it creates the target.

const fs = require("node:fs")
const path = require("node:path")
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins")

const TARGET = "expo-sharing-extension"

module.exports = function withShareExtensionDisplayName(config) {
  const name = config.name
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const plist = path.join(cfg.modRequest.platformProjectRoot, TARGET, "Info.plist")
      const source = fs.readFileSync(plist, "utf8")
      const next = source.replace(
        /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${name}$2`,
      )
      if (next === source && !source.includes(`<string>${name}</string>`)) {
        throw new Error(`Could not set CFBundleDisplayName in ${plist}`)
      }
      fs.writeFileSync(plist, next)
      return cfg
    },
  ])
  return withXcodeProject(config, (cfg) => {
    const objects = cfg.modResults.hash.project.objects
    const target = Object.values(objects.PBXNativeTarget).find((t) => t && t.name === TARGET)
    if (!target) throw new Error(`${TARGET} target missing. Register this plugin before expo-sharing.`)
    const list = objects.XCConfigurationList[target.buildConfigurationList]
    for (const ref of list.buildConfigurations) {
      const settings = objects.XCBuildConfiguration[ref.value].buildSettings
      settings.INFOPLIST_KEY_CFBundleDisplayName = `"${name}"`
    }
    return cfg
  })
}
