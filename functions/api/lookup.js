// Cloudflare Pages Function — served at /api/lookup
//
// Keeps the Anthropic API key on the server; the browser never sees it.
// Requires the caller to send a valid Supabase session token, and caps
// each user to a fixed number of lookups per day so one account can't
// run up your shared Anthropic bill.
//
// Rather than verifying the JWT signature ourselves (which depends on
// which signing system a given Supabase project uses — legacy shared
// secret vs. the newer per-project signing keys), we just ask Supabase
// directly "is this token valid?" via its own auth endpoint. Slightly
// slower (one extra network hop), but it can never go stale no matter
// how Supabase changes their key format in the future.
//
// Requires three environment variables, set in Cloudflare Pages under
// Settings > Environment variables (see README):
//   ANTHROPIC_API_KEY   — your Anthropic API key
//   SUPABASE_URL        — your Supabase project URL
//   SUPABASE_ANON_KEY   — your Supabase publishable/anon key (same one used in index.html)

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

export async function onRequestPost(context) {
  const { request, env } = context;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (!env.ANTHROPIC_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Server is missing ANTHROPIC_API_KEY, SUPABASE_URL, or SUPABASE_ANON_KEY. See README setup steps.' } }),
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

  const user = await getSupabaseUser(token, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  if (!user || !user.id) {
    return new Response(
      JSON.stringify({ error: { message: 'Session expired or invalid — please sign in again.' } }),
      { status: 401, headers: jsonHeaders }
    );
  }

  const usageCount = await incrementLookupUsage(token, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  if (usageCount !== null && usageCount > DAILY_LOOKUP_LIMIT) {
    return new Response(
      JSON.stringify({ error: { message: `Daily lookup limit reached (${DAILY_LOOKUP_LIMIT}/day). Try again tomorrow.` } }),
      { status: 429, headers: jsonHeaders }
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
