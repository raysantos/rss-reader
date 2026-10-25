-- Feeds reader schema. Run once in the Supabase SQL editor (or apply as a migration).
-- (feeds.kind: "feed" or "page", set by the fetcher)
-- Every row belongs to a user; row-level security means each person only ever sees their own data.

create table if not exists public.feeds (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  url          text not null,            -- what you typed (a feed or a normal website)
  feed_url     text,                     -- the real feed address, found by the fetcher
  title        text,
  last_fetched timestamptz,
  last_error   text,
  kind         text check (kind in ('feed','page')),
  created_at   timestamptz not null default now(),
  unique (user_id, url)
);

create table if not exists public.items (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  feed_id    bigint references public.feeds on delete set null,  -- starred items survive removing a feed
  feed_title text,
  guid       text not null,
  title      text,
  link       text,
  summary    text,
  image      text,                     -- preview image URL from the feed
  published  timestamptz,
  read       boolean not null default false,
  starred    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (feed_id, guid)
);

create index if not exists items_user_published on public.items (user_id, published desc nulls last);
create index if not exists items_user_unread    on public.items (user_id) where not read;
create index if not exists items_user_starred   on public.items (user_id) where starred;

alter table public.feeds enable row level security;
alter table public.items enable row level security;

drop policy if exists "own feeds" on public.feeds;
create policy "own feeds" on public.feeds
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own items" on public.items;
create policy "own items" on public.items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
