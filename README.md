# Anime Metadata API — Data Pipeline

A GitHub-hosted anime database (target: 10,000+ titles) stored as JSON files
and kept up to date by GitHub Actions. This repo is **data pipeline only**
(Phases 1–4). The Cloudflare Workers/Pages API (Phase 5) is intentionally
not built yet — see `worker-preview/` for a design sketch you can pick up
when you get there.

## What changed from the original spec, and why

You asked me to find bugs/gaps and fill them in. Here's everything that
was added, fixed, or flagged, so nothing is a surprise:

1. **The episode schema's actual source.** Fields like `anidbEid`,
   `isFiller`, `tvdbShowId`, `tvdbId`, and the `artworks.thetvdb.com`
   screencap URL are **not produced by Jikan, AniList, Kitsu, or
   animeapi.my.id** — none of those four expose AniDB filler flags or TVDB
   episode ids. That exact shape comes from **AniZip** (`api.ani.zip`), a
   free aggregator that merges AniDB + TVDB + dub-availability data per
   episode. I added it as a fifth source (`scripts/lib/aniZip.js`). I
   verified this against AniZip's public usage (it's used by several
   self-hosted anime apps specifically "to provision episode data"), but I
   couldn't hit the live endpoint from this sandbox (network is firewalled
   here), so **test it for real before relying on it** — see "Testing
   this yourself" below.
2. **`themes` and `demographics` were initially being mishandled** — the
   first draft merged Jikan's `themes` (Pirates, School, Military…) into
   `genres`, and silently dropped `demographics` (Shounen/Shoujo/Seinen/
   Josei) entirely. That was fixed by separating them out — and then, per
   a later request to trim the per-anime file, **removed entirely** along
   with `tags`, `licensors`, `background`, `externalLinks`, and
   `streaming` (see item 7 below). `genres` alone is kept.
3. **A real bug in the retry-queue logic**, caught by actually running it:
   when one anime failed against multiple sources in the same run (e.g.
   Jikan _and_ Kitsu _and_ AniList all failed), the `attempts` counter was
   incrementing once _per failed source_ instead of once _per run_, and
   only the last failure reason was kept. Fixed in `scripts/lib/state.js`
   — see "What I actually tested" below for the before/after.
4. **animeapi.my.id's real response shape**, confirmed from its own docs:
   no `mappings` wrapper, no guaranteed `tmdb`/`tvdb` keys (those were
   added to the live dataset later than the rest and aren't in every
   response) — `scripts/lib/idMapping.js` treats every mapping field as
   nullable rather than assuming it's always there.
5. **Webhook URL security.** You pasted a live Discord webhook URL in
   plaintext. Webhook URLs are bearer credentials — anyone who has the URL
   can post to your channel. I didn't hardcode it anywhere; the workflows
   read it from `secrets.DISCORD_WEBHOOK_URL`. **You should regenerate
   that webhook** (Discord channel → Integrations → Webhooks → delete and
   recreate it) since it's now been shared outside your repo, then add the
   new URL as a GitHub Actions secret.
6. Added: retry queue, last-updated cache, per-source rate limiting,
   structured Discord error reporting with a JSON log attachment, and a
   hard-failure vs soft-failure distinction (see below).
7. **Trimmed the per-anime record** (per request, after seeing real output
   for Attack on Titan): removed `themes`, `demographics`, `tags`,
   `licensors`, `background`, `externalLinks`, and `streaming` everywhere
   (not just from the output - the Jikan client no longer even parses
   them, so there's no dead weight sitting in memory either).
   `relations` was also **switched from Jikan to AniList as its source,
   renamed to `sequence`, filtered to anime-only, and sorted
   chronologically**: Jikan only gives `{ malId, type, name }` grouped by
   relation type, which isn't enough to render a "related anime" card
   without a follow-up lookup per entry, and includes manga/light-novel
   source material mixed in with actual anime. AniList's relations query
   returns title/image/format/episodes/seasonYear/release-date per
   related entry directly, so `sequence` is now: (a) filtered to
   `node.type === "ANIME"` only - manga/novel/one-shot adaptations are
   excluded entirely, not just their `type` field; (b) sorted oldest-first
   by release date (falling back to season year, then to "unknown" sorted
   last) so the array order itself shows watch/release order; (c) shaped
   exactly like you asked, with no `type` field in the output:
   `{ malId, title: { romaji, english, native }, image, format, episodes,
seasonYear, relationType }`. Trade-off worth knowing: since this comes
   only from AniList now, a transient AniList failure means
   `sequence: []` for that run rather than a degraded Jikan fallback —
   but that's not silent, it's tracked in `meta.missingSources` and
   retried next run like everything else. I unit-tested the filter+sort
   together with a deliberately out-of-order, mixed anime/manga sample
   (including an entry with only a year and one with no date at all) to
   confirm the ordering logic is actually correct, not just "looks right
   on one example" — see "What I actually tested" below.

## Repository structure

```
data/
├── anime-index.json          # lightweight, list/search-friendly
├── search-index.json         # flattened, every filterable field (advanced search)
├── homepage.json            # comprehensive homepage data (generated by fetch-homepage.js)
├── .pipeline-state/
│   ├── last-updated.json     # { "21": "2026-06-21T...Z" } - freshness cache
│   └── retry-queue.json      # anime that failed last run, retried first next run
└── anime/
    ├── 1.json
    ├── 21.json                # full record, MAL id = filename = canonical id
    └── ...

scripts/
├── lib/
│   ├── httpClient.js          # retry/backoff/timeout fetch wrapper
│   ├── rateLimiter.js         # per-source pacing (Jikan/AniList/Kitsu/...)
│   ├── jikan.js                # PRIMARY metadata source
│   ├── kitsu.js                # FALLBACK metadata source
│   ├── anilist.js              # enrichment (banner art, sequence, next airing ep)
│   ├── idMapping.js            # animeapi.my.id - cross-platform id mapping
│   ├── aniZip.js               # episode data (the schema you specified)
│   ├── discord.js              # webhook error reporting
│   └── state.js                # last-updated cache + retry queue
├── fetch-anime.js              # fetch + merge ONE anime -> data/anime/{id}.json
├── build-indexes.js            # rebuild all precomputed list/index files
├── update-airing.js            # scheduled job: retry queue + airing anime only
└── add-anime.js                # manual onboarding: single id / list / range

.github/workflows/
├── update-airing.yml           # cron, every 4h
└── add-new-anime.yml           # workflow_dispatch, for Phase 2/3 growth

worker-preview/
└── search-example.js           # Phase 5 design reference, NOT deployed
```

## Data schema

### `data/anime-index.json` (and `trending.json` / `popular.json` / `top-rated.json` — same shape)

```json
{
  "id": 21,
  "title": "One Piece",
  "romajiTitle": "One Piece",
  "nativeTitle": "ワンピース",
  "year": 1999,
  "season": "fall",
  "type": "TV",
  "status": "Currently Airing",
  "episodeCount": null,
  "image": "https://cdn.myanimelist.net/images/anime/21l.jpg",
  "score": 8.69,
  "updatedAt": "2026-06-21T00:00:00.000Z"
}
```

### `data/anime/{id}.json`

The canonical id is the **MyAnimeList id** (`mal_id` from Jikan), matching
your spec. Full shape — see `data/anime/21.json` for a real (hand-checked)
example:

```json
{
  "id": 21,
  "idMal": 21,
  "mappings": {
    "mal": 21,
    "anilist": 21,
    "anidb": 69,
    "kitsu": null,
    "simkl": null,
    "tmdb": null,
    "tvdb": null,
    "trakt": null,
    "traktType": null,
    "shikimori": 21,
    "livechart": null,
    "animeplanet": "one-piece",
    "anisearch": null,
    "notify": null
  },
  "title": {
    "romaji": "...",
    "english": "...",
    "native": "...",
    "synonyms": []
  },
  "type": "TV",
  "source": "Manga",
  "status": "Currently Airing",
  "airing": true,
  "episodeCount": 1100,
  "episodeLength": 24,
  "aired": { "from": "1999-10-20", "to": null },
  "season": "fall",
  "year": 1999,
  "broadcast": { "day": "Sundays", "time": "09:30", "timezone": "Asia/Tokyo" },
  "nextAiringEpisode": { "episode": 1136, "airingAt": 1750000000 },
  "rating": "PG-13 - Teens 13 or older",
  "score": {
    "malScore": 8.69,
    "malScoredBy": 234567,
    "malRank": 90,
    "malPopularity": 22,
    "malMembers": 2200000,
    "malFavorites": 220000,
    "anilistScore": 8.7,
    "anilistPopularity": 567000,
    "anilistFavourites": 123000,
    "kitsuRating": 8.69
  },
  "genres": ["Action", "Adventure", "Fantasy"],
  "studios": ["Toei Animation"],
  "producers": ["Fuji TV", "TAP", "Shueisha"],
  "images": { "poster": "...", "banner": "...", "color": "#e4a127" },
  "trailer": { "youtubeId": "...", "url": "...", "thumbnail": "..." },
  "synopsis": "...",
  "sequence": [
    {
      "malId": 466,
      "title": {
        "romaji": "ONE PIECE: Taose! Kaizoku Ganzack",
        "english": "One Piece: Defeat the Pirate Ganzack!",
        "native": "ONE PIECE 倒せ!海賊ギャンザック"
      },
      "image": "...",
      "format": "OVA",
      "episodes": 1,
      "seasonYear": 1998,
      "relationType": "SIDE_STORY"
    }
  ],
  "episodes": {
    "1": {
      "episode": "1",
      "anidbEid": "286674",
      "isFiller": false,
      "isDubbed": true,
      "length": "25m",
      "airdate": "2024-10-03",
      "title": { "en": "Chinatsu Senpai" },
      "tvdbShowId": 429934,
      "tvdbId": 10152847,
      "seasonNumber": 1,
      "episodeNumber": 1,
      "absoluteEpisodeNumber": 1,
      "runtime": 24,
      "image": "https://artworks.thetvdb.com/banners/v4/episode/10152847/screencap/...jpg",
      "airDate": "2024-09-27"
    }
  },
  "meta": {
    "lastFetched": "2026-06-21T14:00:00.000Z",
    "sourcesUsed": ["jikan", "kitsu", "anilist", "animeapi.my.id", "anizip"],
    "missingSources": [],
    "dataVersion": 1
  }
}
```

`sequence` is anime-only (manga/novel/one-shot source material and
adaptations are filtered out) and sorted **oldest release first**, so the
array order itself tells you what came before what — see "Source
priority" below for exactly how that ordering is computed.

`meta.missingSources` is how a partially-failed fetch stays visible without
blocking the whole pipeline — see "Error handling" below.

## Source priority (per your spec: "mostly from MAL/Jikan or Kitsu")

| Source             | Role       | Notes                                                              |
| ------------------ | ---------- | ------------------------------------------------------------------ |
| **Jikan**          | Primary    | synopsis, genres, studios, score, broadcast                        |
| **Kitsu**          | Fallback   | used when Jikan is down/missing fields; also supplies `ageRating`  |
| **AniList**        | Enrichment | banner image, `nextAiringEpisode`, `sequence` (anime-only, sorted) |
| **animeapi.my.id** | ID mapping | the `mappings` block + the AniList id AniZip needs                 |
| **AniZip**         | Episodes   | the per-episode schema you specified                               |

A title is a **hard failure** (→ retry queue + Discord alert) only if
**both** Jikan and Kitsu fail — those are your two designated primary
sources. If AniList, animeapi.my.id, or AniZip fail, the file is still
written with whatever it has; the gap is recorded in `meta.missingSources`
so a later retry can backfill it without you having to notice manually.

## Rate-limit strategy

- `update-airing.yml` runs every 4 hours and only touches anime where
  `status === "Currently Airing"` (read from `anime-index.json`) — never
  the whole catalog.
- `data/.pipeline-state/last-updated.json` skips anything updated in the
  last 4 hours, so a manual re-run or overlapping trigger doesn't double up.
- Catalog growth (Phase 2/3 — adding new titles) is a **separate** workflow
  (`add-new-anime.yml`, manual trigger) so it never collides with or slows
  down the airing-update schedule.
- Each API gets its own pacing in `scripts/lib/rateLimiter.js`, based on
  published/observed limits (Jikan ~3 req/s, AniList ~30 req/min in
  degraded mode, others paced conservatively since they don't publish a
  hard number). The crawler processes anime **sequentially**, not in
  parallel — parallel hammering of 4–5 free APIs is the fastest way to get
  an IP banned and isn't worth the speedup for an incremental job.

## Error handling ("even if an error happens, do it later")

1. Every source call goes through `httpClient.js`, which retries with
   exponential backoff and respects `Retry-After` on 429s.
2. If a call still fails after retries, it's caught and pushed into an
   `errors` array — **it never throws and kills the whole run.**
3. At the end of a run, all failed ids go into
   `data/.pipeline-state/retry-queue.json` (committed to the repo like
   everything else), and the **next** run processes that queue first.
4. Once per run (not once per failure — that was the bug I fixed), all
   accumulated errors are sent to Discord as one organized report: a
   summary embed (grouped by source, with a sample of failures) plus a
   full JSON log attached as a file, so nothing gets lost even if there
   are 50 failures in one run.
5. **Set up the secret before relying on this:** GitHub repo → Settings →
   Secrets and variables → Actions → New repository secret →
   `DISCORD_WEBHOOK_URL`. If it's unset, the pipeline logs a warning and
   continues — it never crashes because Discord is unreachable.

## Commit strategy

Both workflows: `git add -A`, check `git diff --cached --quiet`, skip the
commit/push entirely if nothing changed, otherwise commit as
`github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`
and push. `[skip ci]` in the commit message avoids the commit re-triggering
another workflow run.

## Advanced search — how it's designed to work

Search/filter dimensions: **genre, studio, producer, score range,
popularity, year range, season, status, type, free-text title.** All
combinable (`genre=Action,Adventure&studio=Toei+Animation&
score_min=7.5&sort=score`).

**Where the data lives:** `data/search-index.json` is a flattened array —
one object per anime with every filterable field already at the top level
(no nested lookups needed). It's rebuilt by `build-indexes.js` every time
the pipeline runs.

**Why not a real database:** at 10,000–50,000 entries, filtering and
sorting that array in plain JS, in-memory, inside a Cloudflare Worker is a
few milliseconds — nowhere near the CPU budget. A Worker fetches
`search-index.json` once (via jsdelivr's GitHub CDN, not raw.githubusercontent.com
— jsdelivr is faster and better-cached for this), caches it in the Workers
Cache API for ~5 minutes, and filters/sorts in JS on each request. This
keeps the data layer's "no database, just JSON + git" philosophy intact
all the way through the API, which is what you said you wanted
(architecture independent of API implementation).

**When to actually add a database:** if the catalog grows past roughly
100k entries, or you want fuzzy/typo-tolerant text search ("One Pece" still
finding One Piece) — at that point look at Cloudflare D1 (it's just SQLite,
easy to slot in under the same query interface) or a hosted search service
like Meilisearch/Typesense. Not before; it'd be premature complexity for a
~10k-title catalog.

See `worker-preview/search-example.js` for the filter/sort implementation
(`filterAndSort()`), already unit-tested with sample data — genre+studio
combos, score ranges, year ranges, producer filtering, and sorting all
verified to return correct results before being included here.

## Testing this yourself

This was built and syntax-checked in a sandboxed environment that **can't
reach** api.jikan.moe, kitsu.io, graphql.anilist.co, animeapi.my.id, or
api.ani.zip (network egress is restricted here). What I could and did
verify for real:

- Every script passes `node --check` (no syntax errors).
- `build-indexes.js` actually runs end-to-end against `data/anime/21.json`
  and produces correct `anime-index.json` / `trending.json` /
  `genre-index.json` / `search-index.json` output (included in this repo,
  not hand-written).
- `fetch-anime.js` and `update-airing.js` were run for real against the
  blocked network: confirmed they fail **gracefully** (structured errors,
  retry queue populated correctly, Discord skip-without-crashing when the
  secret is unset) instead of throwing and killing the process.
- Every per-source normalizer (`normalizeJikan`, `normalizeKitsu`,
  `normalizeAniList`, `normalizeMappings`, `normalizeEpisodes`) was unit
  tested against realistic sample payloads matching each API's documented
  real response shape — including animeapi.my.id's actual published
  Cowboy Bebop example and your exact episode schema — and all produced
  correct output.
- The advanced-search `filterAndSort()` function was unit tested with
  sample anime objects across every filter type (genre, studio, producer,
  score range, year range, text search, sorting) — all returned correct
  results.

What I could **not** test here: an actual live HTTP round-trip to Jikan/
Kitsu/AniList/animeapi.my.id/AniZip. Before turning on the scheduled
workflow, run this locally (or in a GitHub Actions test run) where the
network isn't restricted:

```bash
node scripts/fetch-anime.js 21
cat data/anime/21.json   # check it actually populated, not just shaped right
node scripts/build-indexes.js
```

## Running it

```bash
# Phase 1: one anime
node scripts/fetch-anime.js 21
node scripts/build-indexes.js

# Phase 2: ~100 anime
node scripts/add-anime.js --range=1-100

# Phase 3: thousands (run in chunks - this hits 5 APIs per id, sequentially,
# so a few thousand ids will take hours, not minutes - that's intentional,
# see "Rate-limit strategy")
node scripts/add-anime.js --range=1-3000

# Phase 4: automation
# Push this repo to GitHub, add the DISCORD_WEBHOOK_URL secret, the two
# workflows in .github/workflows/ take it from there.

# Phase 5: not yet - see worker-preview/search-example.js when you're ready
```

## Known limitations / things to revisit

- `trending.json` is sorted by AniList's `popularity` field among
  currently-airing titles, since true "trending" (week-over-week
  popularity delta) isn't something any of these APIs hand you directly —
  computing a real delta would mean storing yesterday's popularity number
  per anime and diffing, which is straightforward to add later if you want
  it more accurate.
- `top-rated.json` uses a minimum vote-count threshold (1000) so a title
  with three 10/10 ratings can't outrank One Piece — tune
  `TOP_RATED_MIN_VOTES` in `build-indexes.js` as the catalog grows.
- AniZip's exact rate limit and uptime guarantees aren't published
  anywhere I could find — it's a free community service, treat it as
  best-effort and lean on the retry queue rather than assuming it's always
  reachable.
- `animeapi.my.id`'s `tmdb`/`tvdb` fields are newer additions to their
  dataset and not guaranteed present for every title — `mappings.tmdb`/
  `mappings.tvdb` will legitimately be `null` for a lot of anime even once
  this is working correctly.

```

```

## Homepage data

The pipeline now generates `data/homepage.json` (via `scripts/fetch-homepage.js`). This file contains all homepage sections in a single JSON payload, using the same card format as individual anime files. Sections include `spotlight`, `trending`, `topByTime` (byDay/byWeek/byMonth), `mostWatched`, `mostPopular`, `latestEpisodes`, `topRated`, and `thisSeasonPopular`. It is refreshed every 12 hours by the `homepage.yml` workflow.

