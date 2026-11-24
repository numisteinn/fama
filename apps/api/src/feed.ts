import { TRANSCRIPT_TYPE } from "./transcript.ts"

export interface FeedItem {
  readonly id: string
  readonly title: string
  readonly author: string | null
  readonly finishedAt: string
  readonly durationMs: number | null
  readonly bookUrl: string
  readonly bookSize: number
  readonly coverUrl: string | null
  /** The language of the episode, for example `is`. `null` when the worker has not detected one. */
  readonly language: string | null
  /** The absolute URL of the WebVTT transcript, or `null` when a chapter has no timing file. */
  readonly transcriptUrl: string | null
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

/**
 * The Podcasting 2.0 transcript tag. The channel says `en`, so the item names its own language when it knows it. No
 * `rel="captions"`: the file is a transcript to read along with, and a WebVTT file has its times anyway.
 */
const transcriptTag = (url: string, language: string | null) =>
  `      <podcast:transcript url="${escapeXml(url)}" type="${TRANSCRIPT_TYPE}"${
    language === null ? "" : ` language="${escapeXml(language)}"`
  }/>`

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
    item.transcriptUrl === null ? null : transcriptTag(item.transcriptUrl, item.language),
    "    </item>",
  ]
    .filter((line) => line !== null)
    .join("\n")

export const renderFeed = (channel: FeedChannel) =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0">`,
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
