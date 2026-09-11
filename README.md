# MAT Orientation Map

Public technician map for Netlify: MAT circles, set clock orientation, live sync to Google Excel via Apps Script.

## Auto-deploy (GitHub → Netlify)

Every `git push` to `main` rebuilds the site automatically once the repo is linked in Netlify.

### 1. GitHub

Repo is created under your GitHub account. Clone / pull as usual.

### 2. Connect Netlify

1. Open [https://app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**
2. Choose **GitHub** → authorize → select this repo
3. Build settings (should auto-detect `netlify.toml`):
   - **Base directory:** (leave empty — this repo *is* the site)
   - **Build command:** (empty)
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions`
4. **Site settings → Environment variables** → Add:
   - `SHEET_WEBHOOK_URL` = your Apps Script web app URL (`…/exec`)
   - `SHEET_WEBHOOK_SECRET` = optional (must match Apps Script `WEBHOOK_SECRET`)
5. Deploy

### 3. After first deploy

- Copy the Netlify URL and share with technicians
- Push to `main` → Netlify deploys a new version automatically

## Excel / Apps Script

1. Redeploy Apps Script (`orientation-sheet-apps-script.gs`) → **Anyone** + **New version**
2. From the Ruckus dashboard: **Update Excel sheet** (writes Terminal + Latitude + Longitude)
3. Sheet columns: `MAT | Terminal | Latitude | Longitude | AP1 | value | … | CAM1 | value | …`

## Local preview

```bash
cp .env.example .env
# edit .env with your webhook URL
npx netlify dev
```

## Behavior

- Default zoom 17
- Polls Excel every 8s
- Click MAT → set AP/camera clock 1–12 → writes Excel
- Activate GPS/compass to find beach (12)
