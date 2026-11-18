export interface FeedItem {
  readonly id: string
  readonly title: string
  readonly author: string | null
  readonly finishedAt: string
  readonly durationMs: number | null
  readonly bookUrl: string
  readonly bookSize: number
  readonly coverUrl: string | null
}

export interface FeedChannel {
  readonly title: string
  readonly author: string
  readonly link: string
  readonly imageUrl: string
  readonly items: ReadonlyArray<FeedItem>
}

const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[char]};`)

const seconds = (durationMs: number) => String(Math.round(durationMs / 1000))

const renderItem = (item: FeedItem) =>
  [
    "    <item>",
    `      <title>${escapeXml(item.title)}</title>`,
    `      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
    `      <pubDate>${new Date(item.finishedAt).toUTCString()}</pubDate>`,
    `      <enclosure url="${escapeXml(item.bookUrl)}" length="${item.bookSize}" type="audio/x-m4a"/>`,
    item.author === null ? null : `      <itunes:author>${escapeXml(item.author)}</itunes:author>`,
    item.durationMs === null ? null : `      <itunes:duration>${seconds(item.durationMs)}</itunes:duration>`,
    item.coverUrl === null ? null : `      <itunes:image href="${escapeXml(item.coverUrl)}"/>`,
    "      <itunes:explicit>false</itunes:explicit>",
    "    </item>",
  ]
    .filter((line) => line !== null)
    .join("\n")

export const renderFeed = (channel: FeedChannel) =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
    "  <channel>",
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.link)}</link>`,
    `    <description>${escapeXml(channel.title)}</description>`,
    "    <language>en</language>",
    `    <itunes:author>${escapeXml(channel.author)}</itunes:author>`,
    `    <itunes:image href="${escapeXml(channel.imageUrl)}"/>`,
    `    <itunes:category text="Education"/>`,
    "    <itunes:explicit>false</itunes:explicit>",
    "    <itunes:type>episodic</itunes:type>",
    `    <itunes:block>Yes</itunes:block>`,
    ...channel.items.map(renderItem),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n")
