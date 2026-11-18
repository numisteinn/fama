import { describe, expect, it } from "vitest"
import { type FeedItem, renderFeed } from "./feed.ts"

const item = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  id: "ep-1",
  title: "Deep Work",
  author: "Cal Newport",
  finishedAt: "2026-11-18T12:00:00.000Z",
  durationMs: 3_725_400,
  bookUrl: "https://fama.example/media/secret/episodes/ep-1/book.m4b",
  bookSize: 12345,
  coverUrl: null,
  ...overrides,
})

const channel = (items: ReadonlyArray<FeedItem>) =>
  renderFeed({
    title: "Fama",
    author: "Fama",
    link: "https://fama.example",
    imageUrl: "https://fama.example/feed/secret/cover.png",
    items,
  })

describe("renderFeed", () => {
  it("renders an Apple Podcasts channel", () => {
    const xml = channel([])
    expect(xml).toContain('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"')
    expect(xml).toContain("<title>Fama</title>")
    expect(xml).toContain("<itunes:author>Fama</itunes:author>")
    expect(xml).toContain('<itunes:image href="https://fama.example/feed/secret/cover.png"/>')
    expect(xml).toContain("<itunes:explicit>false</itunes:explicit>")
    expect(xml).not.toContain("<item>")
  })

  it("renders one item per episode with an absolute m4a enclosure", () => {
    const xml = channel([item(), item({ id: "ep-2", title: "Second" })])
    expect(xml.match(/<item>/g)).toHaveLength(2)
    expect(xml).toContain(
      '<enclosure url="https://fama.example/media/secret/episodes/ep-1/book.m4b" length="12345" type="audio/x-m4a"/>',
    )
    expect(xml).toContain('<guid isPermaLink="false">ep-1</guid>')
    expect(xml).toContain("<pubDate>Wed, 18 Nov 2026 12:00:00 GMT</pubDate>")
    expect(xml).toContain("<itunes:duration>3725</itunes:duration>")
  })

  it("escapes titles, authors and urls", () => {
    const xml = channel([
      item({
        title: `Tom & Jerry <"live"> it's`,
        author: "A&B",
        bookUrl: "https://fama.example/media/a&b/book.m4b",
      }),
    ])
    expect(xml).toContain("<title>Tom &amp; Jerry &lt;&quot;live&quot;&gt; it&apos;s</title>")
    expect(xml).toContain("<itunes:author>A&amp;B</itunes:author>")
    expect(xml).toContain('url="https://fama.example/media/a&amp;b/book.m4b"')
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
  })

  it("leaves out unknown author, duration and cover", () => {
    const xml = channel([item({ author: null, durationMs: null })])
    const itemXml = xml.slice(xml.indexOf("<item>"))
    expect(itemXml).not.toContain("<itunes:author>")
    expect(itemXml).not.toContain("<itunes:duration>")
    expect(itemXml).not.toContain("<itunes:image")
  })

  it("adds the episode cover when there is one", () => {
    const xml = channel([item({ coverUrl: "https://fama.example/media/secret/episodes/ep-1/cover.jpg" })])
    expect(xml).toContain('<itunes:image href="https://fama.example/media/secret/episodes/ep-1/cover.jpg"/>')
  })
})
