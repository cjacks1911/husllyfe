# HUSLLYFE

Self-scoring tracker web app covering Body, Wealth and Drive (plus Strength and Garage). Live at https://husllyfe.com. HUSLLYFE is also Curt's parent brand.

## Stack
- Static HTML/CSS/JS PWA, no build step. `app.js` is the shared engine; each area has its own page and stylesheet (`body.html`, `wealth.html`, `drive.html`, `strength.html`, `garage.html`, `how-it-works.html`).
- `netlify/functions/`: the gate check (`gate-verify.js`, `gate-status.js`, shared `_gate-lib.js`). It signs an HMAC cookie with the `GATE_SECRET` env var.
- `_headers`: cache rules. `sw.js`, `manifest.json` and `assetlinks.json` must never be cached; keep those rules.
- `press/`: marketing screenshots.

## Deploy
Push to `main` and Netlify auto-deploys (project `poetic-dango-630de4`). Never drag-and-drop this folder onto another Netlify site: it once overwrote dipstick.cool by mistake.

## Rules
- Never commit `GATE_SECRET` or other secrets.
- Keep the service worker uncached, or deploys won't reach installed users.
- Curt is on Windows: give PowerShell commands.

## How work moves between Claude (chat) and Claude Code

This repo is shared by two Claude sessions:
- **Claude chat** (claude.ai): plans, specs, research, copy. Writes `HANDOFF.md`.
- **Claude Code** (on Curt's laptop): builds, tests, commits. Updates `STATUS.md`.

**At the start of every Claude Code session:**
1. `git pull` so you have whatever chat pushed.
2. Read `HANDOFF.md`. If it has an open task, that is the job. If it says "No open task", ask Curt what to work on.
3. Read `STATUS.md` for where things stand.

**Before ending a session (or after finishing a task):**
1. Update `STATUS.md`: date, what you built, what's broken or untested, open questions for Curt or chat.
2. In `HANDOFF.md`, mark the task done (move it under "Done") or note exactly where you stopped.
3. Commit and push, so chat can see it.

Keep both files short. `STATUS.md` is the current state, not a diary: rewrite it, don't append forever.
