import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { feedUser } from "../auth.ts"
import cover from "../cover.jpg"
import { EpisodeRepo } from "../episode-repo.ts"
import { renderFeed } from "../feed.ts"
import { mediaKey } from "../media-store.ts"
import { mediaResponse } from "../media.ts"
import { handle, webRequest } from "./kit.ts"

/** The decoded path after `/media/<token>/`, for example `episodes/<id>/book.m4b`. Empty when it does not decode. */
const mediaPathOf = (url: string) => {
  try {
    return new URL(url).pathname.split("/").slice(3).map(decodeURIComponent).join("/")
  } catch {
    return ""
  }
}

export const publicMediaRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/feed/:token/rss.xml",
    handle(
      Effect.gen(function* () {
        const { userId, feedToken } = yield* feedUser
        const origin = new URL((yield* webRequest).url).origin
        const items = yield* (yield* EpisodeRepo).feedItems(userId, origin)
        const xml = renderFeed({
          title: "Fama",
          author: "Fama",
          link: origin,
          imageUrl: `${origin}/feed/${feedToken}/cover.jpg?v=ribbon-fan`,
          items,
        })
        return HttpServerResponse.text(xml, { contentType: "application/rss+xml; charset=utf-8" })
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/feed/:token/cover.jpg",
    handle(
      Effect.as(
        feedUser,
        HttpServerResponse.uint8Array(new Uint8Array(cover), { contentType: "image/jpeg" }),
      ),
    ),
  ),
  ...(["GET", "HEAD"] as const).map((method) =>
    HttpRouter.route(
      method,
      "/media/:token/*",
      handle(
        Effect.gen(function* () {
          const { userId } = yield* feedUser
          const request = yield* webRequest
          const key = mediaKey(userId, mediaPathOf(request.url))
          if (key === null) return HttpServerResponse.text("Not found", { status: 404 })
          return HttpServerResponse.raw(yield* mediaResponse(request, key))
        }),
      ),
    ),
  ),
])
