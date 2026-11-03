# Deploying to Render

`render.yaml` creates one **web service** (Docker, `render` stage of the Dockerfile) and one **Postgres** database.

The web app and the worker run in the same container (`scripts/render-start.sh`). They share job files under `/data`, and a Render disk attaches to only one service, so they can't be split into two services.

## First deploy
1. Render dashboard → **New → Blueprint** → pick this repo and branch. Render reads `render.yaml`.
2. Enter the secrets it asks for:
   - `CREDENTIALS_ENCRYPTION_KEY`: `openssl rand -base64 32`. Keep a copy. If you lose or change it, stored WordPress passwords can't be decrypted.
   - `OPENAI_API_KEY`, `OPENAI_MODEL`.
3. Apply. The first build takes about 10 minutes (Chromium). Database migrations run on start-up.
4. Create the first login from the service's **Shell** tab:
   ```
   cd /app && node --import tsx apps/worker/src/cli.ts user add --email you@example.org --name "Your Name" --approver
   ```
5. Open `https://<service>.onrender.com` and log in. Add WordPress targets on the Targets page, or from the Shell with `cli.ts target add`.

## Notes
- Targets must be public URLs. The SSRF guard blocks private addresses, and `WM_ALLOW_PRIVATE_HOSTS` stays unset. The local seed on `localhost:8088` can't be reached from Render.
- Files under `inputs/` aren't in git or in the image. Upload the style guide PDF on the new-job form. A `brand.json` for `wm brand` has to be copied to the disk and run from the Shell.
- A service with a disk can't run more than one instance, and each deploy has a short downtime.
- Disk backups: Render snapshots disks daily. Postgres backups depend on the database plan.
