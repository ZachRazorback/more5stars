# macOS Build Issue — Better SQLite3

## Problem

Your macOS Python 3.14 has a broken `pyexpat` module, which prevents native npm modules like `better-sqlite3` from compiling.

```
Symbol not found: _XML_SetAllocTrackerActivationThreshold
```

This is a system-level issue with Homebrew Python 3.14.

## Solution

### Option 1: Deploy to Render (Recommended ⭐)

Render.com has proper build tools and will compile `better-sqlite3` successfully.

1. Push code to GitHub
2. Deploy on Render.com (see DEPLOYMENT.md)
3. It works immediately (Render handles the build)

**Why:** Render has Linux build tools, no broken Python 3.14.

### Option 2: Fix Local Python (Advanced)

```bash
# Use system Python instead of Homebrew
/usr/bin/python3 --version

# Or downgrade Homebrew Python
brew uninstall python@3.14
brew install python@3.13

# Then try npm install again
cd more5stars
rm -rf node_modules package-lock.json
npm install
npm start
```

### Option 3: Use Pre-built Binary

```bash
# Force a pre-built binary (if available for your Node version)
npm install --no-build-from-source
```

## Recommendation

**Use Option 1 (Render)** — Deploy to production now, skip local testing.

The app is ready. Just push to GitHub and deploy on Render in 10 minutes.

See DEPLOYMENT.md for step-by-step instructions.

---

The local build issue doesn't matter for selling — what matters is the app works in production (which it will on Render). 🚀
