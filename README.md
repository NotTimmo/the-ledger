# The Ledger — Web Edition (Supabase + Cloudflare Pages / Vercel)

A hosted, multi-device version of your media tracker with real accounts —
sign in on your phone, tablet, and laptop and see the same library on all
of them, protected by an email/password login.

## How it's built

- **The app itself** (`index.html`) — unchanged from the version you've been
  using, except for the login screen and the storage/lookup wiring described
  below.
- **Supabase** — holds user accounts (email/password) and your library data
  (all locked down so each person can only ever see their own rows).
- **"Look up" costs nothing to run.** Every category now pulls from a free,
  official source instead of an AI web search — Google Books, iTunes, RAWG,
  and Comic Vine. See "Look up sources" below for the full breakdown and
  what each one needs.
- **Cloudflare Pages or Vercel** — hosts the site itself, and also runs a small
  serverless function that proxies the Comic Vine part of "Look up" (Comic
  Vine's API blocks direct browser requests, so it needs a small server-side
  relay — nothing costs anything, it's just a routing requirement). This repo
  includes **both** a Cloudflare version (`functions/api/lookup.js`) and a
  Vercel version (`api/lookup.js`) — each platform only recognizes its own
  folder, so having both here is harmless; you only need the one matching
  wherever you actually deploy.
- **`manifest.json` / `sw.js` / `icons/`** — makes the site installable as a
  Progressive Web App (an actual home-screen icon on phones/tablets, opens
  in its own window without browser chrome).

Everything else — sections, view modes, journal, dashboard, imports,
exports, bulk select, duplicate detection — works exactly as before.

## Look up sources

| Category | Source | Needs a key? |
|---|---|---|
| Books | Google Books API | No |
| Movies / TV Shows | iTunes Search API | No |
| Video Games | RAWG.io | Yes — free, client-side (see Step 3) |
| Comics | Comic Vine | Yes — free, server-side (see Step 5) |

None of these have any billing risk — RAWG and Comic Vine are both free
tiers with a request-count cap, not a dollar cap, so the worst case if the
cap is ever hit is that lookups for that category stop working until the
next day/month, never an unexpected bill.

---

## Setup

### Step 1 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free account, then **New Project**.
2. Pick any name/region/password (the password here is for the database itself, not your login — you won't need it day-to-day).
3. Wait a minute or two for the project to finish provisioning.

### Step 2 — Run the database schema

1. In your Supabase project, go to **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this folder, paste its contents in, and click **Run**.
3. This creates the `kv_store` table (your library/journal data) and the `lookup_usage` table (for rate limiting "Look up"), both locked down with Row Level Security — the part that actually makes each person's data private.

> Already ran an earlier version of this file? Just run the whole file
> again — everything in it uses `create table if not exists` / `create or
> replace`, so re-running is safe and will just add the new
> `lookup_usage` table and its function without touching your existing data.

### Step 3 — Get your project credentials

Supabase recently renamed things: what used to be called the "anon key" is
now called the **Publishable key** (you may see both names depending on
when your project was created — they work the same way here).

1. In Supabase, go to **Settings → API Keys**.
2. Copy the **Project URL** (near the top of that page).
3. Under **Publishable key**, copy the key starting with `sb_publish...` (or, if your project still shows the older layout, copy the **`anon` `public`** key — either works).
4. Open `index.html` in this folder and near the top, fill in:
   ```js
   window.SUPABASE_URL = "https://your-project.supabase.co";
   window.SUPABASE_ANON_KEY = "your-publishable-or-anon-key";
   ```
5. While you're in there: get a free RAWG key at [rawg.io/apidocs](https://rawg.io/apidocs) (email signup, no payment info) and fill in `window.RAWG_API_KEY = "...";` a few lines below — this powers the free Video Games lookup. Safe to leave visible in this file, since RAWG has no billing risk.

### Step 4 — Turn off email confirmation (optional, but simpler)

By default, Supabase makes new users confirm their email before they can sign in.
For a personal/family tracker this is usually unnecessary friction:

1. Go to **Authentication → Providers → Email**.
2. Turn **off** "Confirm email".

If you'd rather keep email confirmation on (e.g. this will have several users
and you want it locked down properly), leave it on — the app already handles
that case with a "check your email" message after signup.

### Step 5 — Deploy to Cloudflare Pages or Vercel

**Cloudflare Pages:**
1. Push this folder to a GitHub repository (or use Cloudflare's direct upload option if you'd rather not use Git).
2. In [Cloudflare Pages](https://pages.cloudflare.com), create a new project connected to that repo.
3. Build settings: **no build command needed** — this is a static site. Leave the build command blank and set the output directory to `/` (the repo root).
4. Before deploying, go to your Pages project's **Settings → Environment variables** and add:
   - `SUPABASE_URL` — the same Project URL from Step 3
   - `SUPABASE_ANON_KEY` — the same Publishable/anon key from Step 3
   - `COMICVINE_API_KEY` — free key from [comicvine.gamespot.com/api](https://comicvine.gamespot.com/api/) (email signup, no payment info) — powers the free Comics lookup
   - `ANTHROPIC_API_KEY` — only needed if you want the old AI-based lookup available as a fallback; nothing in the app currently calls it, since every category now has a free source
5. Deploy. Cloudflare will give you a `*.pages.dev` URL — that's your site. It'll use `functions/api/lookup.js` automatically.

**Vercel (alternative):**
1. Push this folder to a GitHub repository.
2. In [Vercel](https://vercel.com), import that repo as a new project. No framework preset needed — it's a static site with one API route.
3. Before deploying, go to the project's **Settings → Environment Variables** and add:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — same as Step 3
   - `COMICVINE_API_KEY` — free key from [comicvine.gamespot.com/api](https://comicvine.gamespot.com/api/) — powers the free Comics lookup
   - `ANTHROPIC_API_KEY` — optional, only needed for the unused AI-lookup fallback
4. Deploy. Vercel will give you a `*.vercel.app` URL. It'll use `api/lookup.js` automatically — Vercel maps any file under `/api` at the repo root to a matching endpoint with no extra config. This uses the standard Node.js Serverless Function format (Vercel's current default) rather than the standalone Edge Runtime, which Vercel deprecated in June 2025.

### Step 6 — Try it

Visit your new URL, sign up with an email and password, and you should land
in the app. Try opening the same URL on your phone and signing in with the
same account — same library, same data. On your phone's browser, look for
"Add to Home Screen" — it'll install like a real app, icon and all.

---

## Ongoing costs

- **Supabase free tier**: comfortably covers a personal or family-sized library — you'd need a genuinely large amount of data or a lot of simultaneous users to approach its limits.
- **Cloudflare Pages free tier**: very generous for a site this size; realistically won't be an issue.
- **Anthropic API**: only the "Look up" feature costs anything, and it's a small fraction of a cent per lookup. Everything else in the app (library, journal, dashboard) costs nothing to run.

## Security notes

- Each user's data is protected by Postgres Row Level Security — even
  with direct database access via the API, one user's rows are invisible
  to another user's account.
- The lookup function checks with Supabase directly that the caller has a
  valid, signed-in session before it will proxy anything (including the
  Comic Vine relay), so the endpoint can't be used by someone who hasn't
  signed in. This also means it keeps working correctly even if Supabase
  changes their token signing format in the future — nothing here
  depends on that.
- **No AI cost by default.** "Look up" no longer calls Claude for any
  category — every lookup goes through a free API (Google Books, iTunes,
  RAWG, or Comic Vine), none of which bill by usage. RAWG and Comic Vine
  are request-capped (not cost-capped), so the worst case if a cap is hit
  is that lookups pause until the next day/month — never a surprise bill.
- The old Anthropic-based fallback path is still in both lookup functions
  (unused unless something explicitly calls it) with its original
  protections intact: `ANTHROPIC_API_KEY` never reaches the browser, and
  each signed-in user would be capped at 100 calls/day via the
  `lookup_usage` table if that path were ever reactivated. Adjust
  `DAILY_LOOKUP_LIMIT` in either lookup file if you ever bring it back
  and want a different cap.

## Recommended: turn on database backups

Once this is holding your real library (not just test data), it's worth
turning on **Point-in-Time Recovery** under your Supabase project's
**Settings → Add-ons** (or **Database → Backups**, depending on your plan).
This means a bug, an accidental bulk delete, or anything else that goes
wrong can be undone, rather than being permanent. It's a small monthly
cost on top of the free tier, but worth it once there's real data at stake.

## Custom domain (optional)

Cloudflare Pages supports adding your own domain for free under
**your Pages project → Custom domains**. Not required — the `*.pages.dev`
address works fine on its own.

## Local testing (optional)

If you want to test before deploying, `npx wrangler pages dev .` (requires
Node.js) will serve the site locally, including the `/api/lookup` function,
as long as you set the two environment variables in a local `.dev.vars` file.
