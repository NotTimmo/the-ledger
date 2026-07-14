// Vercel Edge Function — served at /api/lookup
//
// This is the Vercel-compatible twin of functions/api/lookup.js (which is
// Cloudflare Pages' function format and only works when deployed there).
// Vercel automatically turns any file under /api/*.js at the repo root
// into a serverless endpoint at that same path — no other config needed,
// as long as this file lives at api/lookup.js in the repo root.
//
// Logic is identical to the Cloudflare version: keeps the Anthropic API
// key server-side, requires a valid Supabase session, and caps each user
// to a fixed number of lookups per day so one account can't run up your
// shared Anthropic bill.
//
// Requires the same three environment variables, set in Vercel under
// Project Settings > Environment Variables:
//   ANTHROPIC_API_KEY   — your Anthropic API key
//   SUPABASE_URL        — your Supabase project URL
//   SUPABASE_ANON_KEY   — your Supabase publishable/anon key (same one used in index.html)

export const config = { runtime: 'edge' };

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

export default async function handler(request) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Use POST' } }),
      { status: 405, headers: jsonHeaders }
    );
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Server is missing ANTHROPIC_API_KEY, SUPABASE_URL, or SUPABASE_ANON_KEY. Set these in Vercel > Project Settings > Environment Variables.' } }),
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

  const user = await getSupabaseUser(token, SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!user || !user.id) {
    return new Response(
      JSON.stringify({ error: { message: 'Session expired or invalid — please sign in again.' } }),
      { status: 401, headers: jsonHeaders }
    );
  }

  const usageCount = await incrementLookupUsage(token, SUPABASE_URL, SUPABASE_ANON_KEY);
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
      'x-api-key': ANTHROPIC_API_KEY,
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
