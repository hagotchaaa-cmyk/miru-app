// ═══════════════════════════════════════════════════════
//  MIRU — Matching Backend
//  Stack: Node.js + Express + Supabase
//  File: server.js
//  Run: node server.js
// ═══════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── SUPABASE CLIENT ──────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key — server only, never expose
);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ════════════════════════════════════════════════════
//  MATCHING ENGINE
// ════════════════════════════════════════════════════

// ── SCORING WEIGHTS ──────────────────────────────────
const WEIGHTS = {
  intent:    40,   // must match — biggest factor
  vibe:      30,   // how many vibes in common
  distance:  20,   // closer = higher score
  tone:      10,   // AI video tone analysis (future)
};
const MIN_SCORE     = 55;   // loose bar — show more people
const MAX_DISTANCE  = 50;   // miles — max distance to consider
const DAILY_LIMIT   = 3;    // max AI matches per day

// ── INTENT MAP ───────────────────────────────────────
// Only these intents can match with each other
const INTENT_COMPAT = {
  'relationship': ['relationship'],
  'casual':       ['casual', 'exploring'],
  'friends':      ['friends', 'networking'],
  'exploring':    ['casual', 'exploring', 'relationship'],
  'networking':   ['friends', 'networking'],
};

// ── DISTANCE CALCULATOR (Haversine formula) ──────────
function getDistanceMiles(lat1, lon1, lat2, lon2) {
  const R    = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat/2) * Math.sin(dLat/2) +
               Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
               Math.sin(dLon/2) * Math.sin(dLon/2);
  const c    = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
function toRad(deg) { return deg * (Math.PI / 180); }

// ── CORE SCORING FUNCTION ────────────────────────────
function scoreMatch(userA, userB) {
  const score = { total: 0, intent: 0, vibe: 0, distance: 0, tone: 0, breakdown: {} };

  // 1. INTENT — must be compatible or score = 0
  const compatIntents = INTENT_COMPAT[userA.intent] || [];
  if (!compatIntents.includes(userB.intent)) {
    return { ...score, disqualified: true, reason: 'Intent mismatch' };
  }
  // Perfect intent match = full points, compatible = 80%
  score.intent = userA.intent === userB.intent ? WEIGHTS.intent : Math.round(WEIGHTS.intent * 0.8);

  // 2. AGE RANGE — both must fall in each other's preferred range
  const aWantsB = userB.age >= userA.age_pref_min && userB.age <= userA.age_pref_max;
  const bWantsA = userA.age >= userB.age_pref_min && userA.age <= userB.age_pref_max;
  if (!aWantsB || !bWantsA) {
    return { ...score, disqualified: true, reason: 'Age range mismatch' };
  }

  // 3. VIBE SCORE — overlap of vibe arrays
  const vibesA   = new Set(userA.vibes || []);
  const vibesB   = new Set(userB.vibes || []);
  const overlap  = [...vibesA].filter(v => vibesB.has(v)).length;
  const maxVibes = Math.max(vibesA.size, vibesB.size, 1);
  score.vibe     = Math.round((overlap / maxVibes) * WEIGHTS.vibe);

  // 4. DISTANCE SCORE
  if (userA.lat && userA.lng && userB.lat && userB.lng) {
    const miles = getDistanceMiles(userA.lat, userA.lng, userB.lat, userB.lng);
    if (miles > MAX_DISTANCE) {
      return { ...score, disqualified: true, reason: 'Too far away' };
    }
    // Closer = higher score. 0 miles = full points, 50 miles = 0 points
    score.distance = Math.round(Math.max(0, 1 - (miles / MAX_DISTANCE)) * WEIGHTS.distance);
    score.breakdown.miles = Math.round(miles * 10) / 10;
  } else {
    // No location data — give half credit
    score.distance = Math.round(WEIGHTS.distance * 0.5);
  }

  // 5. AI TONE SCORE (placeholder — will connect to OpenAI/Anthropic vision API)
  // When video analysis is live, this will analyze energy, humor, warmth from video
  score.tone = WEIGHTS.tone * 0.6; // default 60% until video analysis is live

  // TOTAL
  score.total = Math.round(score.intent + score.vibe + score.distance + score.tone);
  score.breakdown = {
    ...score.breakdown,
    intent:   score.intent,
    vibe:     score.vibe,
    distance: score.distance,
    tone:     score.tone,
    total:    score.total,
    qualified: score.total >= MIN_SCORE,
  };

  return score;
}

// ── RUN DAILY MATCHING FOR ONE USER ─────────────────
async function runMatchingForUser(userId) {
  try {
    // Get the user's full profile
    const { data: user, error: userErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (userErr || !user) throw new Error('User not found: ' + userId);

    // Check if they already have matches today
    const today = new Date().toISOString().split('T')[0];
    const { data: existing } = await supabase
      .from('daily_matches')
      .select('id')
      .eq('user_id', userId)
      .eq('match_date', today);

    if (existing && existing.length >= DAILY_LIMIT) {
      console.log(`⏭️  User ${userId} already has ${existing.length} matches today`);
      return { skipped: true, reason: 'Already has matches today' };
    }

    const needed = DAILY_LIMIT - (existing?.length || 0);

    // Get candidate pool — exclude self, exclude already matched/passed
    const { data: passed } = await supabase
      .from('user_actions')
      .select('target_id')
      .eq('user_id', userId)
      .in('action', ['pass', 'connect']);

    const excludeIds = [userId, ...(passed?.map(p => p.target_id) || [])];

    // Filter by gender preference at DB level for efficiency
    const { data: candidates, error: candErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('is_active', true)
      .eq('ai_mode', true)          // only match with users who have AI mode on
      .not('id', 'in', `(${excludeIds.map(id => `'${id}'`).join(',')})`)
      .limit(200);                   // score top 200 candidates

    if (candErr) throw candErr;

    // Score every candidate
    const scored = (candidates || [])
      .map(candidate => ({
        candidate,
        score: scoreMatch(user, candidate),
      }))
      .filter(r => !r.score.disqualified && r.score.total >= MIN_SCORE)
      .sort((a, b) => b.score.total - a.score.total)  // highest score first
      .slice(0, needed);

    if (scored.length === 0) {
      console.log(`⚠️  No qualified matches found for user ${userId}`);
      return { matched: 0, reason: 'No candidates passed scoring' };
    }

    // Save matches to DB
    const matchRows = scored.map(r => ({
      user_id:    userId,
      match_id:   r.candidate.id,
      score:      r.score.total,
      breakdown:  r.score.breakdown,
      match_date: today,
      status:     'pending',       // pending → confirmed/passed by user
      mode:       'ai',
    }));

    const { error: insertErr } = await supabase
      .from('daily_matches')
      .insert(matchRows);

    if (insertErr) throw insertErr;

    console.log(`✅  Matched user ${userId} with ${scored.length} people (scores: ${scored.map(r=>r.score.total).join(', ')})`);

    // Send push notification (if they have a push token)
    if (user.push_token) {
      await sendPushNotification(user.push_token, {
        title: 'Your 3 matches are ready ✦',
        body:  'Good morning! We found some great people for you today.',
        data:  { screen: 'matches' },
      });
    }

    return { matched: scored.length, scores: scored.map(r => r.score.total) };

  } catch (err) {
    console.error(`❌  Matching error for user ${userId}:`, err.message);
    return { error: err.message };
  }
}

// ── RUN MATCHING FOR ALL AI MODE USERS ───────────────
async function runDailyMatching() {
  console.log('\n🌅  Running daily matching job —', new Date().toLocaleString());

  const { data: users, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('is_active', true)
    .eq('ai_mode', true);

  if (error) { console.error('Failed to fetch users:', error); return; }

  console.log(`👥  Processing ${users.length} AI-mode users...`);

  // Process in batches of 10 to avoid overwhelming the DB
  const BATCH = 10;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    await Promise.all(batch.map(u => runMatchingForUser(u.id)));
    if (i + BATCH < users.length) {
      await new Promise(r => setTimeout(r, 500)); // small delay between batches
    }
  }

  console.log('✅  Daily matching complete\n');
}

// ── PUSH NOTIFICATION ─────────────────────────────────
async function sendPushNotification(token, payload) {
  // Expo push notifications (free, works for iOS + Android)
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:    token,
        title: payload.title,
        body:  payload.body,
        data:  payload.data,
        sound: 'default',
      }),
    });
  } catch (err) {
    console.warn('Push notification failed:', err.message);
  }
}

// ════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════

// ── AUTH MIDDLEWARE ───────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// ── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    app:     'Miru Matching API',
    status:  'running',
    version: '1.0.0',
    time:    new Date().toISOString(),
  });
});

// ── GET TODAY'S MATCHES ───────────────────────────────
app.get('/api/matches/today', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('daily_matches')
    .select(`
      id, score, breakdown, status, mode, created_at,
      match:profiles!daily_matches_match_id_fkey (
        id, name, age, city, lat, lng,
        intent, vibes, bio, avatar_url, video_url,
        video_prompt, age_pref_min, age_pref_max
      )
    `)
    .eq('user_id', req.user.id)
    .eq('match_date', today)
    .order('score', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    matches:    data || [],
    count:      data?.length || 0,
    date:       today,
    next_batch: getNext9AM(),
  });
});

// ── CONFIRM OR PASS A MATCH ───────────────────────────
app.post('/api/matches/:matchId/action', requireAuth, async (req, res) => {
  const { matchId } = req.params;
  const { action }  = req.body; // 'confirm' | 'pass'

  if (!['confirm', 'pass'].includes(action)) {
    return res.status(400).json({ error: 'Action must be confirm or pass' });
  }

  // Update match status
  const { data: match, error } = await supabase
    .from('daily_matches')
    .update({ status: action === 'confirm' ? 'confirmed' : 'passed' })
    .eq('id', matchId)
    .eq('user_id', req.user.id)
    .select('*, match:profiles!daily_matches_match_id_fkey(id, name, push_token)')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Record action for future matching exclusions
  await supabase.from('user_actions').insert({
    user_id:   req.user.id,
    target_id: match.match_id,
    action:    action === 'confirm' ? 'connect' : 'pass',
  });

  // If confirmed — check if it's a mutual match (explore mode)
  if (action === 'confirm' && match.mode === 'explore') {
    const { data: theirAction } = await supabase
      .from('user_actions')
      .select('id')
      .eq('user_id', match.match_id)
      .eq('target_id', req.user.id)
      .eq('action', 'connect')
      .single();

    if (theirAction) {
      // It's a mutual match — create conversation
      const { data: convo } = await supabase
        .from('conversations')
        .insert({
          user_a: req.user.id,
          user_b: match.match_id,
          matched_at: new Date().toISOString(),
        })
        .select()
        .single();

      // Notify both users
      if (match.match?.push_token) {
        await sendPushNotification(match.match.push_token, {
          title: "It's a match! ✦",
          body:  "You both connected. Say something real.",
          data:  { screen: 'messages', convoId: convo?.id },
        });
      }

      return res.json({ action, mutual_match: true, conversation_id: convo?.id });
    }
  }

  // AI mode confirm — auto-creates conversation
  if (action === 'confirm' && match.mode === 'ai') {
    const { data: convo } = await supabase
      .from('conversations')
      .insert({
        user_a:     req.user.id,
        user_b:     match.match_id,
        matched_at: new Date().toISOString(),
        mode:       'ai',
      })
      .select()
      .single();

    // Notify the matched person
    if (match.match?.push_token) {
      await sendPushNotification(match.match.push_token, {
        title: 'Someone wants to connect ✦',
        body:  'Miru found you a match. Check it out.',
        data:  { screen: 'matches' },
      });
    }

    return res.json({ action, conversation_id: convo?.id });
  }

  res.json({ action, match_id: matchId });
});

// ── EXPLORE MODE — LIKE SOMEONE ───────────────────────
app.post('/api/explore/like', requireAuth, async (req, res) => {
  const { target_id, is_super } = req.body;

  if (!target_id) return res.status(400).json({ error: 'target_id required' });

  // Record the like
  await supabase.from('user_actions').upsert({
    user_id:   req.user.id,
    target_id,
    action:    is_super ? 'super' : 'connect',
  });

  // Check if target already liked this user back
  const { data: theirLike } = await supabase
    .from('user_actions')
    .select('id')
    .eq('user_id', target_id)
    .eq('target_id', req.user.id)
    .in('action', ['connect', 'super'])
    .single();

  if (theirLike) {
    // Mutual match — create conversation
    const { data: convo } = await supabase
      .from('conversations')
      .insert({
        user_a:     req.user.id,
        user_b:     target_id,
        matched_at: new Date().toISOString(),
        mode:       'explore',
      })
      .select()
      .single();

    // Get target's push token
    const { data: targetProfile } = await supabase
      .from('profiles')
      .select('push_token, name')
      .eq('id', target_id)
      .single();

    if (targetProfile?.push_token) {
      await sendPushNotification(targetProfile.push_token, {
        title: "It's a match! ✦",
        body:  "You both liked each other. Say something real.",
        data:  { screen: 'messages', convoId: convo?.id },
      });
    }

    return res.json({ mutual: true, conversation_id: convo?.id });
  }

  res.json({ mutual: false, liked: true });
});

// ── EXPLORE FEED — GET PEOPLE TO BROWSE ──────────────
app.get('/api/explore/feed', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  // Get user profile for scoring
  const { data: user } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();

  // Get already seen/acted profiles
  const { data: acted } = await supabase
    .from('user_actions')
    .select('target_id')
    .eq('user_id', req.user.id);

  const excludeIds = [req.user.id, ...(acted?.map(a => a.target_id) || [])];

  const { data: candidates } = await supabase
    .from('profiles')
    .select('id, name, age, city, lat, lng, intent, vibes, bio, avatar_url, video_url, video_prompt, age_pref_min, age_pref_max')
    .eq('is_active', true)
    .not('id', 'in', `(${excludeIds.map(id=>`'${id}'`).join(',')})`)
    .limit(100);

  // Score and sort
  const feed = (candidates || [])
    .map(c => ({ ...c, _score: scoreMatch(user, c) }))
    .filter(c => !c._score.disqualified)
    .sort((a, b) => b._score.total - a._score.total)
    .slice(0, limit)
    .map(c => ({
      id:           c.id,
      name:         c.name,
      age:          c.age,
      city:         c.city,
      intent:       c.intent,
      vibes:        c.vibes,
      bio:          c.bio,
      avatar_url:   c.avatar_url,
      video_url:    c.video_url,
      video_prompt: c.video_prompt,
      match_score:  c._score.total,
      distance_mi:  c._score.breakdown?.miles,
    }));

  res.json({ feed, count: feed.length });
});

// ── TOGGLE AI MODE ────────────────────────────────────
app.post('/api/settings/mode', requireAuth, async (req, res) => {
  const { ai_mode } = req.body;

  const { error } = await supabase
    .from('profiles')
    .update({ ai_mode })
    .eq('id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    ai_mode,
    message: ai_mode
      ? 'AI matching enabled. Your daily 3 drop at 9am.'
      : 'Explore mode on. You control who you like.',
  });
});

// ── SAVE PROFILE ──────────────────────────────────────
app.post('/api/profile', requireAuth, async (req, res) => {
  const { name, age, city, gender, intent, vibes, availability,
          age_pref_min, age_pref_max, bio, lat, lng, ai_mode } = req.body;

  const { data, error } = await supabase
    .from('profiles')
    .upsert({
      id:           req.user.id,
      name, age, city, gender, intent, vibes, availability,
      age_pref_min, age_pref_max, bio, lat, lng,
      ai_mode:      ai_mode ?? true,
      is_active:    true,
      updated_at:   new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// ── GET CONVERSATIONS ──────────────────────────────────
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id, matched_at, mode, last_message, last_message_at,
      user_a_profile:profiles!conversations_user_a_fkey(id, name, age, avatar_url),
      user_b_profile:profiles!conversations_user_b_fkey(id, name, age, avatar_url)
    `)
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`)
    .order('last_message_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Format so the "other" person is always in `match`
  const formatted = (data || []).map(c => ({
    id:           c.id,
    matched_at:   c.matched_at,
    mode:         c.mode,
    last_message: c.last_message,
    match: c.user_a_profile?.id === req.user.id
      ? c.user_b_profile
      : c.user_a_profile,
  }));

  res.json({ conversations: formatted });
});

// ── SEND MESSAGE ───────────────────────────────────────
app.post('/api/conversations/:convoId/messages', requireAuth, async (req, res) => {
  const { convoId } = req.params;
  const { content }  = req.body;

  if (!content?.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

  // Verify user is part of this conversation
  const { data: convo } = await supabase
    .from('conversations')
    .select('id, user_a, user_b')
    .eq('id', convoId)
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`)
    .single();

  if (!convo) return res.status(403).json({ error: 'Not part of this conversation' });

  // Insert message
  const { data: msg, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: convoId,
      sender_id:       req.user.id,
      content:         content.trim(),
      created_at:      new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Update conversation last message
  await supabase
    .from('conversations')
    .update({
      last_message:    content.trim().slice(0, 100),
      last_message_at: new Date().toISOString(),
    })
    .eq('id', convoId);

  // Push notification to other user
  const otherId = convo.user_a === req.user.id ? convo.user_b : convo.user_a;
  const { data: other } = await supabase
    .from('profiles')
    .select('push_token, name')
    .eq('id', otherId)
    .single();

  if (other?.push_token) {
    await sendPushNotification(other.push_token, {
      title: 'New message ✦',
      body:  content.trim().slice(0, 80),
      data:  { screen: 'messages', convoId },
    });
  }

  res.json({ message: msg });
});

// ── MANUAL TRIGGER (admin / testing) ─────────────────
app.post('/api/admin/run-matching', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  runDailyMatching();
  res.json({ message: 'Matching job started' });
});

// ── SCORE TWO USERS (admin / debug) ──────────────────
app.post('/api/admin/score', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { userA, userB } = req.body;
  const score = scoreMatch(userA, userB);
  res.json({ score });
});

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════
function getNext9AM() {
  const now  = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// ════════════════════════════════════════════════════
//  CRON JOB — runs every day at 9:00 AM
// ════════════════════════════════════════════════════
cron.schedule('0 9 * * *', () => {
  runDailyMatching();
}, {
  timezone: 'America/Phoenix',
});

// ════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   MIRU Matching API — running   ║
  ║   http://localhost:${PORT}          ║
  ╠══════════════════════════════════╣
  ║   Daily matching: 9:00 AM MST   ║
  ║   Min match score: ${MIN_SCORE}/100        ║
  ║   Max distance: ${MAX_DISTANCE} miles         ║
  ╚══════════════════════════════════╝
  `);
});

module.exports = { app, scoreMatch, runMatchingForUser };
