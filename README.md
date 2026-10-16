MrFunnehBuilder alive bot
Run locally (do this first for Microsoft login)
npm install
node bot.js
Sign in with the code it prints. Login tokens get saved in ./auth.
Deploy on Render
Push this folder to GitHub (auth/ is git-ignored, keep it that way).
Render > New > Blueprint (or Web Service) > pick the repo.
Render > your service > Environment > Secret Files: add every file from your local ./auth folder
(same filenames). The bot copies them in at startup so it doesn't need an interactive login.
Free web services sleep after ~15 min without traffic: point UptimeRobot/cron-job.org at your
https://<service>.onrender.com/ every 5 min. A paid "worker" doesn't need this.
Env vars
MC_AUTH (microsoft|offline), MC_USERNAME, MC_VERSION, RECONNECT_MS, WANDER_RADIUS,
CHAT_ENABLED (true|false), CHAT_TIMES (e.g. 14:00,20:30), CHAT_MIN_MINUTES, CHAT_MAX_MINUTES, TZ (e.g. America/New_York)
