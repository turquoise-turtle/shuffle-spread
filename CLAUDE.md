# shuffle-spread — working notes

Two independent pieces. Neither imports the other; they meet at two small
handover formats (see README).

- **The page** (`index.html`, `style.css`, `main.js`) — pure ordering. No
  network, no accounts. Given shows and counts, produces a running order.
- **The userscript** (`pocketcasts-upnext.user.js`) — all Pocket Casts I/O.
  Runs on the web player, reads what is unplayed, writes Up Next or a playlist.

Keep that split. The page must stay useful with no Pocket Casts account, and
the userscript must not grow ordering logic of its own.

## House style

- Tabs. `var` and `function () {}` throughout — no `const`/`let`, no arrows.
  Not for compatibility; just consistency with what is already there.
- No build step, no dependencies, no package.json. Files are served as-is by
  GitHub Pages and read as-is by Tampermonkey. Keep it that way.
- en-AU in prose, comments and UI strings. Not in CSS properties (`color`),
  DOM APIs (`scrollIntoView({behavior})`) or third-party field names.
- Comments explain *why*, especially where the code looks odd because the API
  is odd. Those comments are the record of what was learned the hard way.
- Bump `@version` in the userscript on any change, or Tampermonkey will not
  offer the update.

## The Pocket Casts API

Unofficial and reverse-engineered. Two sources, and they disagree:

- The **apps** are open source (`Automattic/pocket-casts-android`,
  `modules/services/servers/.../sync/SyncService.kt` lists every route).
- The **web player** often uses different shapes for the same endpoint, and the
  web player is what we run inside. **Where they differ, the web player wins.**
  Verify against a real captured request before trusting the Kotlin.

### Confirmed against real captured requests

| Call | Body | Notes |
|---|---|---|
| `POST /user/podcast/list` | `{v: 1}` | JSON, not protobuf. `v` is a number. |
| `POST /user/podcast/episodes` | `{uuid}` (a **podcast**) | play state only, for episodes you have touched |
| `POST /user/podcast/episode/bookmarks` | `{uuid, podcast}` (an **episode**) | reads one episode's state: `playingStatus`, `playedUpTo`, `isDeleted`, `starred`, `duration`, `bookmarks`, `deselectedChapters`. A read despite the POST. |
| `POST /user/podcast/episodes/bookmarks` | `{uuid}` (a **podcast**) | what the player uses instead. Same per-episode rows plus `starred`, `duration`, `bookmarks`, `deselectedChapters`, and the podcast's `autoStartFrom` / `autoSkipLast` / `episodesSortOrder` alongside. A superset of the above. |
| `POST /up_next/list` | `{version: 2, model: "webplayer", serverModified, showPlayStatus: true}` | reading the queue. What the web player uses, and what we use. Returns `{serverModified, episodes[], episodeSync[]}`; `serverModified` is a string of ms and must be fed back on the next read. |
| `POST /up_next/sync` | the same body | answers that same read identically, and is what we used to ask. The player has moved off it for reads. Still the route the one-shot replace is attempted on — see below. |
| `POST /up_next/play_last` | `{version: 2, episode: {uuid, title, url, podcast, published}}` | appends one; returns the whole queue |
| `GET /user/playlists` | — | `manual: true` are hand-curated; the rest are saved filters. A manual playlist carries `episodeOrder` **and** `episodes`, and they are mirror images: `episodes` runs oldest `added` first, `episodeOrder` newest first. |
| `PUT /user/playlists/{p}/episode/{e}` | the whole playlist | see the trap below |
| `DELETE /user/playlists/{p}/episode/{e}` | `{}` | removes that one episode. Returns the whole playlist as it now stands. The body is an empty JSON object, not absent — send it. |
| `GET /subscription/status` | — | `tier` (`"Plus"`), `features`. Nothing here gates anything we do. |
| `GET cache.pocketcasts.com/mobile/podcast/full/{uuid}` | — | 302s to `podcasts.pocketcasts.com/{uuid}/episodes_full_{ts}.json`; full episode list, **newest first**. Unauthenticated — the player sends no bearer, only `Origin`. |

`playingStatus` comes back as `0` as well as the documented `1` / `2` / `3`, and
`0` is common. It appears to mean "no state recorded" rather than "not played" —
in a captured podcast every `0` row also had `isDeleted: true`. We treat anything
that is not `3` as unplayed, so this costs us nothing, but do not read `0` as a
fourth playing state.

### Assumed, not confirmed

- `up_next/sync` with an Android-style `upNext.changes` array and `action: 5`
  (replace). The Up Next write path still tries it and verifies.

## Traps, each of which has already cost a debugging round

**The playlist PUT is not a whole-playlist write.** It adds *one* episode — the
one in the URL — and **prepends** it. The body carries the full playlist but the
server decides placement. Write a running order **back to front** or it comes out
reversed. This was shipped wrong once.

A captured playlist confirms the mechanism from the other end: every entry's
`added` timestamp rises down the `episodes` array while `episodeOrder` runs the
other way, so the server is ordering by `added` descending. Our back-to-front
write, with a fresh `Date.now()` per `PUT`, lands correctly under that rule.

The same trap bit the playlist **restore**, which sent one `PUT` carrying the
whole backed-up playlist and reported success. One `PUT` re-adds one episode, so
it restored one of N and said otherwise; after an Add there were also extra
episodes that only a `DELETE` could remove. Restore is now the same clear,
re-add back to front, read back as Replace.

**`POST /user/episode` will reset play progress.** The player sends it before its
playlist PUT, carrying the episode's full metadata (`duration`, `fileType`,
`size`, `episodeNumber`, …) alongside `playingStatus: 1, playedUpTo: 0`. We
queue in-progress episodes by design, so replaying that would wipe exactly the
progress that matters. Deliberately omitted. If added back, send the real state
from `/user/podcast/episodes`.

**The feed JSON can be partial and does not look it.** `episodes_full` carries
`has_more_episodes`, and it is newest-first, so a truncated response drops the
*oldest* episodes — exactly the ones you are working through. Every show captured
so far came back `false` — including one carrying all 540 of its episodes — so we
have never seen it true and `loadUnplayed` does not check it. If a long-running
show ever comes up short, look here first.

**CORS allows `pocketcasts.com` but not `www.pocketcasts.com`** — the latter is a
flat 403. Never add a `www` match. `play.pocketcasts.com` 301s to the bare host
and is matched only for old bookmarks.

**Do not guard the panel on URL paths.** That host serves the marketing site too,
but the player's paths cannot be enumerated: signed out, `/podcasts` bounces to
`/user/login` while `/upnext` and `/files` 404. Wait for a token instead — one
only exists once the player has authenticated.

**Never let a write silently fall back to a different write.** Replace once
degraded into Add this way. A fallback that runs after a *stale read* can also
double-apply. Prefer one deterministic path that reports failure over a clever
one with a rescue.

**Read back after writing.** Do not report success because a call returned 200.

## Testing

There is no test account, so nothing can be run end to end. What works instead:

- Throwaway harnesses in the scratchpad (they do not survive the session, so
  rebuild rather than hunt for them): `eval` a slice of the real source by
  string offset, feed it mocks **built from captured payloads**, assert. Do not
  hand-write expected shapes from memory — copy them from a real capture.
- Simulate the server's actual quirks, not its documented behaviour. The
  prepend-on-PUT simulation is what proved the ordering fix.
- Ordering invariants worth re-asserting after any change to the shuffle:
  episodes of a show stay ascending; any prefix holds episodes 1..j with no
  gaps; caps compose; `randomise: false` reproduces a plain even interleave.

## Asking the user for captures

They have been happy to paste real requests from DevTools, and it has settled
every question the Kotlin could not. Ask for: request URL and method, request
payload, response content-type, and the first stretch of the response. Remind
them to scrub the `Authorization` value and their email; podcast and episode
uuids are public and fine to keep.

## Environment

The Tampermonkey install URL points at `raw.githubusercontent.com/.../master/`,
so nothing installs or updates until a commit is on the remote. As of
2026-09-09 `origin/master` matches local `master` (`git ls-remote origin master`),
so everything through `7eb7d03` is live — an earlier 403 on `git push`, blamed on
an osxkeychain credential without write scope, is no longer blocking. The default
branch is `master`, not `main`.

The page has never been rendered. The Chrome extension was not connected and
headless Chrome hangs in this sandbox, so the CSS is unverified.
