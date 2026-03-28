-- ═══════════════════════════════════════════════
--  MIRU — Supabase Database Schema
--  Run this in your Supabase SQL Editor
-- ═══════════════════════════════════════════════

-- ── PROFILES ─────────────────────────────────────
-- Extends Supabase auth.users
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  name            text not null,
  age             int  not null check (age >= 18),
  gender          text,
  city            text,
  lat             float,
  lng             float,
  bio             text,
  intent          text,  -- 'relationship' | 'casual' | 'friends' | 'exploring' | 'networking'
  vibes           text[] default '{}',
  availability    text[] default '{}',
  age_pref_min    int  default 18,
  age_pref_max    int  default 99,
  avatar_url      text,
  video_url       text,
  video_prompt    text,
  push_token      text,   -- Expo push token for notifications
  ai_mode         boolean default true,  -- true = AI picks, false = explore mode
  is_active       boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', 'New User'));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ── DAILY MATCHES ─────────────────────────────────
create table daily_matches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  match_id    uuid references profiles(id) on delete cascade,
  score       int  not null,       -- 0-100
  breakdown   jsonb,               -- score breakdown per factor
  match_date  date not null default current_date,
  status      text default 'pending',  -- 'pending' | 'confirmed' | 'passed'
  mode        text default 'ai',       -- 'ai' | 'explore'
  created_at  timestamptz default now(),
  unique(user_id, match_id, match_date)
);

-- ── USER ACTIONS ──────────────────────────────────
-- Tracks every like, pass, super — used to exclude from future matching
create table user_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  target_id   uuid references profiles(id) on delete cascade,
  action      text not null,  -- 'connect' | 'pass' | 'super'
  created_at  timestamptz default now(),
  unique(user_id, target_id)
);

-- ── CONVERSATIONS ─────────────────────────────────
create table conversations (
  id               uuid primary key default gen_random_uuid(),
  user_a           uuid references profiles(id) on delete cascade,
  user_b           uuid references profiles(id) on delete cascade,
  matched_at       timestamptz default now(),
  mode             text default 'ai',  -- 'ai' | 'explore'
  last_message     text,
  last_message_at  timestamptz,
  created_at       timestamptz default now(),
  unique(user_a, user_b)
);

-- ── MESSAGES ──────────────────────────────────────
create table messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references conversations(id) on delete cascade,
  sender_id        uuid references profiles(id) on delete cascade,
  content          text not null,
  read_at          timestamptz,
  created_at       timestamptz default now()
);

-- ── MEDIA ─────────────────────────────────────────
-- Photos and videos attached to a profile
create table media (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  type        text not null,  -- 'photo' | 'video'
  url         text not null,
  prompt      text,           -- for videos: which prompt they answered
  duration    int,            -- seconds
  is_primary  boolean default false,
  sort_order  int default 0,
  created_at  timestamptz default now()
);

-- ── INDEXES (for fast matching queries) ───────────
create index idx_profiles_active     on profiles(is_active);
create index idx_profiles_ai_mode    on profiles(ai_mode);
create index idx_profiles_intent     on profiles(intent);
create index idx_profiles_location   on profiles(lat, lng);
create index idx_daily_matches_user  on daily_matches(user_id, match_date);
create index idx_user_actions_user   on user_actions(user_id);
create index idx_messages_convo      on messages(conversation_id, created_at);

-- ── ROW LEVEL SECURITY ────────────────────────────
-- Users can only read/write their own data
alter table profiles      enable row level security;
alter table daily_matches enable row level security;
alter table user_actions  enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table media         enable row level security;

-- Profiles: public read (for matching feed), private write
create policy "Profiles are viewable by authenticated users"
  on profiles for select using (auth.role() = 'authenticated');
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- Daily matches: only see your own
create policy "Users see own matches"
  on daily_matches for select using (auth.uid() = user_id);

-- Conversations: see convos you're part of
create policy "Users see own conversations"
  on conversations for select
  using (auth.uid() = user_a or auth.uid() = user_b);

-- Messages: see messages in your conversations
create policy "Users see messages in their conversations"
  on messages for select
  using (
    exists (
      select 1 from conversations c
      where c.id = conversation_id
      and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );
create policy "Users can send messages"
  on messages for insert
  with check (auth.uid() = sender_id);

-- Media: public read, own write
create policy "Media is viewable by all"
  on media for select using (auth.role() = 'authenticated');
create policy "Users manage own media"
  on media for all using (auth.uid() = user_id);

-- ── REALTIME ──────────────────────────────────────
-- Enable realtime for messages (live chat)
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table daily_matches;
