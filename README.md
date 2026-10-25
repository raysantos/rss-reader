# Feeds

A private, no-frills RSS/Atom reader. The page is a static site on GitHub Pages, and your feeds, articles, and read/starred state live in your own Supabase database, so everything syncs across your phone and PC.

- **No dependencies.** Plain HTML/JS and a plain Node script. No build step, no libraries.
- **Private.** You sign in with an emailed magic link, once per device. Row-level security means the database only returns your own rows. Nothing personal is stored in this repo.
- **Manage feeds in the page.** Paste a feed address or just a website, and the fetcher finds the site's feed.
- **Features:** unread tracking, starring, mark all read, and a light/dark toggle.

## How it works

```
GitHub Action (every 15 min) ──fetch feeds──▶ Supabase (feeds, items)
                                                   ▲
GitHub Pages: docs/index.html ──your login─────────┘
```

## Setup

1. **Create a Supabase project** (the free tier is fine).
2. **Create the tables:** run `supabase/schema.sql` in the SQL editor.
3. **Set up sign-in:**
   - Go to Authentication → URL Configuration and set the Site URL to `https://raysantos.github.io/rss-reader/`.
   - Go to Authentication → Users → Add user, and create yourself with your email.
   - Go to Authentication → Sign In / Providers and turn off "Allow new users to sign up."
4. **Connect the page:** put your project URL and publishable key in `docs/config.js`. Both are safe to publish.
5. **Connect the fetcher:** add the repo secrets `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The secret key never goes in the page.
   ```
   gh secret set SUPABASE_URL -R raysantos/rss-reader
   gh secret set SUPABASE_SECRET_KEY -R raysantos/rss-reader
   ```
6. Open the site, sign in, and add feeds with the RSS button in the header.

## Settings

- To change how often feeds are checked, edit the `cron` in `.github/workflows/fetch.yml`.
- To change how much is kept, edit `MAX_PER_FEED` and `KEEP_DAYS` in `scripts/fetch.mjs`. Unstarred articles older than 60 days are removed; starred ones are kept forever.
