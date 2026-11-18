import type { ExpoConfig } from "expo/config"

const bundleIdentifier = "dev.fama.app"

const dmSans = [
  "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
]

// Links, plain text, PDF and EPUB. Images and video stay out of the share sheet.
const shareActivationRule = `SUBQUERY(extensionItems, $item, SUBQUERY($item.attachments, $attachment,
  ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.url"
  OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.plain-text"
  OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "com.adobe.pdf"
  OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "org.idpf.epub-container"
).@count >= 1).@count >= 1`.replace(/\s+/g, " ")

const config: ExpoConfig = {
  name: "Fama",
  slug: "fama",
  scheme: "fama",
  version: "0.1.0",
  platforms: ["ios"],
  orientation: "portrait",
  userInterfaceStyle: "dark",
  backgroundColor: "#0B0B0C",
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier,
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ["audio"],
      // Self-hosted servers often run on plain HTTP inside a LAN or tailnet.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription: "Fama connects to your Fama server on your local network.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [
    "expo-router",
    ["expo-font", { ios: { fonts: dmSans } }],
    "expo-secure-store",
    "./plugins/withShareExtensionDisplayName.cjs",
    [
      "expo-sharing",
      {
        ios: {
          enabled: true,
          extensionBundleIdentifier: `${bundleIdentifier}.share`,
          appGroupId: `group.${bundleIdentifier}`,
          activationRule: shareActivationRule,
        },
        android: { enabled: false },
      },
    ],
    [
      "expo-splash-screen",
      { image: "./assets/icon.png", imageWidth: 120, backgroundColor: "#0B0B0C" },
    ],
  ],
  experiments: { typedRoutes: false },
}

export default config
