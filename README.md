# Feeds

A private, no-frills RSS/Atom reader. A GitHub Action fetches your feeds every hour, encrypts the result with your passcode, and saves it to the repo. A single static page on GitHub Pages decrypts it in your browser.

- **No dependencies.** Plain Node script, plain HTML/JS, no build step.
- **Private on a public repo.** Your feed list is a GitHub secret, and the articles are stored AES-256 encrypted. Without the passcode the repo only shows scrambled data, and search engines are told not to index the page.
- **Features:** unread tracking, starring, mark all read, and a light/dark toggle. Read and starred state stays in each browser.

## Setup (about 5 minutes)

1. Create a new GitHub repo (public is fine) and push these files to it.
2. Go to **Settings → Secrets and variables → Actions → New repository secret** and add two secrets:
   - `PASSCODE`: the passphrase you'll type to open the reader. Make it long; anyone with the data file could try to guess it offline.
   - `FEEDS`: your feed URLs, one per line. Lines starting with `#` are ignored.
3. Go to **Settings → Pages** and set the source to *Deploy from a branch*, branch `main`, folder `/docs`.
4. Go to **Actions → Fetch feeds → Run workflow** for the first fetch. After that it runs hourly.
5. Open `https://<you>.github.io/<repo>/` and enter your passcode.

## Day to day

- **Add or remove feeds:** edit the `FEEDS` secret, then run the workflow (or wait for the next hour).
- **Change the passcode:** update the `PASSCODE` secret and run the workflow. Old devices will ask for the new one.
- **Refresh now:** Actions → Fetch feeds → Run workflow.
- **Limits:** the newest 30 items per feed and 400 overall are kept. Change `MAX_PER_FEED` and `MAX_TOTAL` at the top of `scripts/fetch.mjs`. Starred items are saved in full, so they stay after they age out.
- Commits only happen when new articles arrive, so the repo stays small.

## Test locally

```sh
printf "https://example.com/feed.xml\n" > feeds.local.txt   # git-ignored
PASSCODE=test node scripts/fetch.mjs
cd docs && python3 -m http.server   # open http://localhost:8000
```
