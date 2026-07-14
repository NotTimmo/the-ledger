// Vercel Function — served at /api/lookup
//
// This is the Vercel-compatible twin of functions/api/lookup.js (which is
// Cloudflare Pages' function format and only works when deployed there).
// Vercel automatically turns any file under /api/*.js at the repo root
// into a serverless endpoint at that same path — no other config needed,
// as long as this file lives at api/lookup.js in the repo root.
//
// Uses the classic Node.js Serverless Function signature (req, res) —
// this is Vercel's current default runtime. An earlier version of this
// file used the standalone Edge Runtime (`export const config = { runtime:
// 'edge' }`), but Vercel deprecated that product in June 2025 in favor of
// Node.js as the default for everything, so that's been removed here.
//
// This endpoint now handles two different things, told apart by the
// request body shape:
//   1. { provider: 'comicvine', query: '...' } — free Comics lookup.
//      Comic Vine's API blocks direct browser requests (no CORS support),
//      so it has to be proxied server-side like this even though it's
//      free and needs no per-user rate limiting.
//   2. Anything else — the original Anthropic "Look up" proxy, for
//      whatever's left that doesn't have a free API (kept here in case
//      it's ever needed again, but nothing in the app currently calls it,
//      since every category now has a free source).
//
// Requires these environment variables, set in Vercel under Project
// Settings > Environment Variables:
//   SUPABASE_URL        — your Supabase project URL
//   SUPABASE_ANON_KEY   — your Supabase publishable/anon key (same one used in index.html)
//   ANTHROPIC_API_KEY   — only needed if the Anthropic path is ever used again
//   COMICVINE_API_KEY   — free key from comicvine.gamespot.com/api — only needed for Comics lookups

const DAILY_LOOKUP_LIMIT = 100;

async function getSupabaseUser(token, supabaseUrl, anonKey) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': anonKey
    }
  });
  if (!res.ok) return null;
  return await res.json();
}

// Increments today's lookup count for this user via a Postgres RPC
// (see supabase/schema.sql) and returns the new total. Using the
// caller's own token (not a service key) means Row Level Security
// still applies — this can only ever touch the signed-in user's own row.
async function incrementLookupUsage(token, supabaseUrl, anonKey) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_lookup_usage`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': anonKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_day: today })
  });
  if (!res.ok) return null; // fail open — a tracking hiccup shouldn't block a legitimate lookup
  return await res.json();
}

async function searchComicVine(query, apiKey) {
  const url = `https://comicvine.gamespot.com/api/search/?api_key=${encodeURIComponent(apiKey)}&format=json&resources=volume&query=${encodeURIComponent(query)}&field_list=name,start_year,publisher,image,deck,description&limit=2`;
  // Comic Vine asks every client to send a real User-Agent, or it may
  // reject the request.
  const res = await fetch(url, { headers: { 'User-Agent': 'TheLedger/1.0 (personal media tracker)' } });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data.results)) return [];

  return data.results.map(r => {
    const rawDesc = (r.deck || r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const description = rawDesc.length > 140 ? rawDesc.slice(0, 137) + '…' : rawDesc;
    const cover = r.image && (r.image.medium_url || r.image.original_url || r.image.small_url);
    return {
      title: r.name || query,
      creator: (r.publisher && r.publisher.name) || '',
      year: r.start_year || '',
      coverImageUrl: cover || null,
      description
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Use POST' } });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(500).json({ error: { message: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY. Set these in Vercel > Project Settings > Environment Variables, then redeploy.' } });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: { message: 'Not signed in.' } });
    return;
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }

  try {
    const user = await getSupabaseUser(token, SUPABASE_URL, SUPABASE_ANON_KEY);
    if (!user || !user.id) {
      res.status(401).json({ error: { message: 'Session expired or invalid — please sign in again.' } });
      return;
    }

    // ---- Path 1: free Comic Vine lookup (no cost, no rate limiting needed) ----
    if (body.provider === 'comicvine') {
      const COMICVINE_API_KEY = process.env.COMICVINE_API_KEY;
      if (!COMICVINE_API_KEY) {
        res.status(500).json({ error: { message: 'Server is missing COMICVINE_API_KEY. Get a free key at comicvine.gamespot.com/api and add it in Vercel > Project Settings > Environment Variables.' } });
        return;
      }
      const matches = await searchComicVine(body.query || '', COMICVINE_API_KEY);
      res.status(200).json({ matches });
      return;
    }

    // ---- Path 2: Anthropic proxy (kept for compatibility, unused by the app currently) ----
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      res.status(500).json({ error: { message: 'Server is missing ANTHROPIC_API_KEY.' } });
      return;
    }

    const usageCount = await incrementLookupUsage(token, SUPABASE_URL, SUPABASE_ANON_KEY);
    if (usageCount !== null && usageCount > DAILY_LOOKUP_LIMIT) {
      res.status(429).json({ error: { message: `Daily lookup limit reached (${DAILY_LOOKUP_LIMIT}/day). Try again tomorrow.` } });
      return;
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('lookup function error', err);
    res.status(500).json({ error: { message: 'Unexpected server error — check Vercel function logs for details.' } });
  }
}
