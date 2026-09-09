# shuffle-spread

Interleaves several podcasts into one running order, spreading each show evenly
across the whole queue instead of clumping it together.

Two pieces that work on their own or together:

| | |
|---|---|
| **[The page](https://turquoise-turtle.github.io/shuffle-spread/)** | List your shows and how many episodes you have left, press Shuffle, copy the running order. |
| **[The userscript](pocketcasts-upnext.user.js)** | On the Pocket Casts web player: reads what you actually have left, and turns a running order back into your Up Next queue. |

## How the shuffle works

Every show is laid out along the same 0–1 line, so a show with 4 episodes left
takes up as much of the queue as one with 40 — it just has bigger gaps. Sorting
all the episodes by that position interleaves them proportionally.

With **Randomise** on, each show gets a random offset along the line and each
episode a small nudge, so repeat shuffles differ without a show ever clumping.
With it off you get a plain even interleave, which is what the original version
of this did. Episodes of a show always stay in order.

Inspired by [keyj's balanced shuffle](https://keyj.emphy.de/balanced-shuffle/).

## Using it with Pocket Casts

Everything below works on the free plan — the web player and Up Next have both
been free [since March 2025](https://blog.pocketcasts.com/2025/03/11/webplayer/).

1. Install [Tampermonkey](https://www.tampermonkey.net/), then add
   `pocketcasts-upnext.user.js`.
2. Open [play.pocketcasts.com](https://play.pocketcasts.com/) and press
   **Spread shuffle** in the bottom right.
3. **Load subscriptions** — tick the shows you are working through. This is a
   whitelist: nothing joins the shuffle until you tick it, so subscribing to
   something new later will not quietly drop its backlog into your queue. The
   ticks are remembered between visits.
4. **Count episodes** — only the ticked shows are checked, so this stays quick
   however many podcasts you subscribe to.
5. **Open shuffle page** — it opens pre-filled. Shuffle, then **Copy**.
6. Back on the player, paste into the panel, press **Preview**, check the order,
   then **Replace Up Next**.

Your previous queue is saved first, and a **Restore previous queue** button
appears in the panel afterwards.

Episodes always go in oldest first, and a show's episodes keep that order no
matter how the shuffle interleaves them. Ordering is by publication date, parsed
rather than string-compared, so feeds using an offset like `+10:00` instead of
UTC still land in the right place.

Two other things worth knowing: trailers and bonus episodes count as unplayed
like anything else, and if a show's play state cannot be read the script stops
rather than guess, so it never queues something you have already heard.

### What it talks to

Pocket Casts has no official API, but the apps are open source and the web
player's own endpoints allow cross-origin calls from `play.pocketcasts.com`,
which is where the userscript runs. It uses:

| Endpoint | Body | For |
|---|---|---|
| `POST api.pocketcasts.com/user/podcast/list` | `{v: 1}` | your subscriptions |
| `POST api.pocketcasts.com/user/podcast/episodes` | `{uuid}` | what you have played or archived |
| `GET cache.pocketcasts.com/mobile/podcast/full/{uuid}` | — | the full episode list for a show |
| `POST api.pocketcasts.com/up_next/sync` | `{version: 2, model: "webplayer", serverModified, showPlayStatus: true}` | reading the queue |
| `POST api.pocketcasts.com/up_next/play_last` | `{version: 2, episode: {…}}` | appending one episode |

Writing the queue is the awkward part. The web player only ever *reads* through
`up_next/sync` — its changes go one episode at a time through `play_last` and
friends. The mobile apps can also push a whole queue in one request by sending a
change list to `up_next/sync` with action `5`, per
[`UpNextSyncRequest.kt`](https://github.com/Automattic/pocket-casts-android/blob/main/modules/services/servers/src/main/java/au/com/shiftyjelly/pocketcasts/servers/sync/UpNextSyncRequest.kt).

So the script tries that one-shot replace, re-reads the queue to check it
actually landed, and if it did not, offers to append the episodes one by one
instead. Nothing is assumed to have worked without reading it back.

The script never asks for your password: it lifts the bearer token off the web
player's own requests, which is why it runs at `document-start`.

This is all unofficial and could break whenever Pocket Casts changes something.

## The handover format

The two pieces are deliberately decoupled — neither needs the other to work.

- **Userscript → page**: `#shows=` on the URL, holding `[{k: uuid, t: title, n: count}]`.
- **Page → userscript**: one tab-separated line per episode, `uuid`, index
  (1-based, oldest first), then the show title for legibility.

Because the key is a podcast uuid, nothing depends on matching show names. Typing
shows in by hand still works — the key falls back to a slug of the title.
