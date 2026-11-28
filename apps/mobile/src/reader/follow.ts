// The reader's scroll-follow: whether the list follows the active sentence, or the listener scrolled away and
// reads on their own. Dragging pauses auto-scroll so it does not fight the finger. The "Back to now" pill and a
// tap on a sentence follow again. Nothing here touches React or the list: it is the state the screen renders.

/** `following`: auto-scroll keeps the active sentence in sight. `scrolled`: the listener reads elsewhere. */
export type Follow = "following" | "scrolled"

/** What the listener did to the list. */
export type FollowEvent = { readonly _tag: "DragStart" } | { readonly _tag: "BackToNow" } | { readonly _tag: "SentenceTap" }

/** One step of the follow state. Dragging pauses auto-scroll; "Back to now" and a sentence tap follow again. */
export const followNext = (event: FollowEvent): Follow => {
  switch (event._tag) {
    case "DragStart":
      return "scrolled"
    case "BackToNow":
    case "SentenceTap":
      return "following"
  }
}

/** The "Back to now" pill shows while the listener has scrolled away from the active sentence. */
export const showsBackToNow = (follow: Follow): boolean => follow === "scrolled"
