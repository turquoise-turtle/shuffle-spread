# shuffle-spread

Interleaves several podcasts into one running order, spreading each show evenly
across the whole queue instead of clumping it together.

Two pieces that work on their own or together:

| | |
|---|---|
| **[The page](https://turquoise-turtle.github.io/shuffle-spread/)** | List your shows and how many episodes you have left, press Shuffle, copy the running order. |
| **[The userscript](pocketcasts-upnext.user.js)** | On the Pocket Casts web player: reads what you actually have left, and turns a running order back into your Up Next queue or a manual playlist. |

## How the shuffle works

Every show is laid out along the same 0–1 line, so a show with 4 episodes left
takes up as much of the queue as one with 40 — it just has bigger gaps. Sorting
all the episodes by that position interleaves them proportionally.

With **Randomise** on, each show gets a random offset along the line and each
episode a small nudge, so repeat shuffles differ without a show ever clumping.
With it off you get a plain even interleave, which is what the original version
of this did. Episodes of a show always stay in order.

Inspired by [keyj's balanced shuffle](https://keyj.emphy.de/balanced-shuffle/).

## Not queueing the whole backlog

Two limits, either or both:

- **at most _n_ per show** — takes the oldest _n_ of each show
- **cap the queue at _n_** — trims the shuffled order to the first _n_

They do quite different things when your backlogs are uneven. With 251, 50, 12
and 8 episodes left across four shows:

| | Bible | Casefile | 99% Inv | Rebuilders |
|---|---|---|---|---|
| cap 40 total | 32 | 6 | 1 | 1 |
| at most 5 per show | 5 | 5 | 5 | 5 |
| 10 per show, capped at 25 | 7 | 7 | 6 | 5 |

The total cap keeps each show proportional to how much of it you have left, so
a big backlog dominates. The per-show cap gives every show equal footing. Set
both and the per-show limit applies first.

Either way you always get a show's *next* episodes with no gaps — never episode
5 without 1 to 4 — because episodes only ever move forwards along the line, so
trimming can only ever cut from the end.

## Using it with Pocket Casts

Everything below works on the free plan — the web player and Up Next have both
been free [since March 2025](https://blog.pocketcasts.com/2025/03/11/webplayer/).

1. Install [Tampermonkey](https://www.tampermonkey.net/), then
   **[click here to install the script](https://raw.githubusercontent.com/turquoise-turtle/shuffle-spread/master/pocketcasts-upnext.user.js)**
   — Tampermonkey recognises the `.user.js` URL and offers an install screen.
   It then checks that same URL for updates on its own, so a `git push` here is
   all it takes to ship one. Bump `@version` or Tampermonkey will ignore the
   change. To update by hand: Tampermonkey dashboard → **Utilities** → **Check
   for userscript updates**.
2. Open [pocketcasts.com/podcasts](https://pocketcasts.com/podcasts) and press
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

### Playlists

The destination dropdown lists Up Next plus any **manual** playlist. Saved
filters are deliberately left out — the server decides what is in those, so
writing episodes to one would achieve nothing.

`PUT /user/playlists/{playlist}/episode/{episode}` adds **one** episode, and
**prepends** it — the body carries the whole playlist, but the server decides the
placement, not you. So the script walks the running order backwards, one PUT per
episode, and the playlist ends up reading forwards.

**Add** leaves what is already there below the new episodes. **Replace** deletes
the existing ones first, and if that fails it stops without adding anything
rather than quietly behaving like Add. Either way the previous contents are
backed up and a restore button appears.

Removal is assumed to be `DELETE` on the same path. That is the one call here
not confirmed against a real request, so Replace checks the playlist really did
empty before it adds anything.

One thing the script deliberately does *not* copy from the web player: before
its playlist `PUT`, the player also sends `POST /user/episode` carrying
`playingStatus: 1, playedUpTo: 0`. Replaying that would reset your progress on
any part-played episode, so it is left out. If a newly added episode ever shows
up without its artwork or duration, that omission is the first thing to suspect.

### What it talks to

Pocket Casts has no official API, but the apps are open source and the web
player's own endpoints allow cross-origin calls from `pocketcasts.com`, which is
where the userscript runs. (The old `play.pocketcasts.com` now redirects there;
the script still matches it in case you have an old bookmark. `www.pocketcasts.com`
is *not* an allowed origin — the API returns 403 — so the script does not run
there.) It uses:

| Endpoint | Body | For |
|---|---|---|
| `POST api.pocketcasts.com/user/podcast/list` | `{v: 1}` | your subscriptions |
| `POST api.pocketcasts.com/user/podcast/episodes` | `{uuid}` | what you have played or archived |
| `GET cache.pocketcasts.com/mobile/podcast/full/{uuid}` | — | the full episode list for a show |
| `POST api.pocketcasts.com/up_next/sync` | `{version: 2, model: "webplayer", serverModified, showPlayStatus: true}` | reading the queue |
| `POST api.pocketcasts.com/up_next/play_last` | `{version: 2, episode: {…}}` | appending one episode |
| `GET api.pocketcasts.com/user/playlists` | — | your playlists |
| `PUT api.pocketcasts.com/user/playlists/{playlist}/episode/{episode}` | the whole playlist | adding to a playlist |

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
