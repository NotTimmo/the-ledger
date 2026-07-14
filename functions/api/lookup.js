// Cloudflare Pages Function — served at /api/lookup
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
// Rather than verifying the Supabase JWT signature ourselves (which
// depends on which signing system a given Supabase project uses — legacy
// shared secret vs. the newer per-project signing keys), we just ask
// Supabase directly "is this token valid?" via its own auth endpoint.
// Slightly slower (one extra network hop), but it can never go stale no
// matter how Supabase changes their key format in the future.
//
// Requires these environment variables, set in Cloudflare Pages under
// Settings > Environment variables (see README):
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY. See README setup steps.' } }),
      { status: 500, headers: jsonHeaders }
    );
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return new Response(
      JSON.stringify({ error: { message: 'Not signed in.' } }),
      { status: 401, headers: jsonHeaders }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid request body' } }),
      { status: 400, headers: jsonHeaders }
    );
  }

  const user = await getSupabaseUser(token, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  if (!user || !user.id) {
    return new Response(
      JSON.stringify({ error: { message: 'Session expired or invalid — please sign in again.' } }),
      { status: 401, headers: jsonHeaders }
    );
  }

  // ---- Path 1: free Comic Vine lookup (no cost, no rate limiting needed) ----
  if (body.provider === 'comicvine') {
    if (!env.COMICVINE_API_KEY) {
      return new Response(
        JSON.stringify({ error: { message: 'Server is missing COMICVINE_API_KEY. Get a free key at comicvine.gamespot.com/api and add it in Cloudflare Pages > Settings > Environment variables.' } }),
        { status: 500, headers: jsonHeaders }
      );
    }
    const matches = await searchComicVine(body.query || '', env.COMICVINE_API_KEY);
    return new Response(JSON.stringify({ matches }), { status: 200, headers: jsonHeaders });
  }

  // ---- Path 2: Anthropic proxy (kept for compatibility, unused by the app currently) ----
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Server is missing ANTHROPIC_API_KEY.' } }),
      { status: 500, headers: jsonHeaders }
    );
  }

  const usageCount = await incrementLookupUsage(token, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  if (usageCount !== null && usageCount > DAILY_LOOKUP_LIMIT) {
    return new Response(
      JSON.stringify({ error: { message: `Daily lookup limit reached (${DAILY_LOOKUP_LIMIT}/day). Try again tomorrow.` } }),
      { status: 429, headers: jsonHeaders }
    );
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await upstream.json();

  return new Response(JSON.stringify(data), {
    status: upstream.status,
    headers: jsonHeaders
  });
}

// Reject other methods explicitly rather than falling through silently.
export async function onRequestGet() {
  return new Response(JSON.stringify({ error: { message: 'Use POST' } }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' }
  });
}
