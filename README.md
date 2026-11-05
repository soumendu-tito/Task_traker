# Daymark Task Tracker

A Windows desktop task tracker built with Electron and Node.js. The app keeps its profile, task list, tracked time, Telegram bot token, and optional screenshots on the current Windows device.

## Install on Windows

Run `release/Task-Tracker-Setup-1.0.0.exe` and follow the installer. The setup can create a desktop shortcut and Start menu entry. The installer is not code signed, so Windows may show its standard publisher prompt.

## Start developing

Install Node.js 20 or newer, then run:

```powershell
npm install
npm start
```

Build a Windows installer with:

```powershell
npm run dist
```

The installer is written to `release/`.

## First launch

Create a local profile with your name and email. This is a single-device workspace; it does not create a cloud login or sync data between computers.

## Telegram

1. In Telegram, open `@BotFather`, use `/newbot`, and copy the bot token.
2. In Cloud Staff, open **Telegram**, paste the token and choose **Connect bot**.
3. Choose **Generate pairing code**, open the bot shown in the app, and send `/start YOUR_CODE`.
4. Send `/online` to start tracking, `/break` or `/off` to pause, `/task Your task` to save a task, and `/status` to see tracked time.

The bot token is stored in this local app's data folder to support reconnection. Disconnect it from the Telegram screen to remove the saved token.

## Workspace members

Open **Workspace**, enter a teammate's name and Telegram username (with or without `@`), then share the generated invite link. Telegram does not allow a bot to initiate a private chat; the teammate must open the link and press **Start**. The bot verifies the username, then saves the Telegram account ID internally for future status updates and imports their profile photo when available. Teammates can use `/online`, `/break`, `/task ...`, and `/status`. Remove access with **Delete** on their member card.

## Remote computer relay

The relay admin token is for the workspace owner only. The owner enters it in **Verify administrator** to unlock bot and Workspace management. Teammates need only the public relay URL and their Telegram username to pair their own computers; they must not receive the relay admin token or bot token. Workspace add, invite, and delete controls are hidden until the relay validates admin access. The owner must unlock admin access again after reopening the desktop app.

The relay is required when Telegram commands must control tracking and screenshot capture on each teammate's own computer. It receives Telegram webhooks once and routes commands to the matching running desktop app. Without this service, the desktop app can only update workspace status locally.

1. Deploy this project on a public Node.js host with HTTPS and persistent storage. Set `PUBLIC_URL` to the public HTTPS base URL, `RELAY_ADMIN_TOKEN` to a long random secret, and `DATA_DIR` to a persistent directory. Start the service with `npm run relay` (or the host's equivalent start command).
2. Check `https://your-relay.example.com/health` returns `{"ok":true,...}`.
3. On the workspace owner's desktop app, open **Telegram connection**. Enter the relay URL and RELAY_ADMIN_TOKEN, then choose **Verify administrator**. After verification, enter the Telegram bot token in the administrator controls and choose **Connect bot to relay**. Add or remove people from **Workspace**; these controls are administrator-only.
4. Each teammate installs and opens the desktop app on their own computer. Their Task Tracker profile name must match the workspace member name. They do not need the relay admin token or bot token. In **Telegram connection**, enter the relay URL and their Telegram username, choose **Generate computer link**, then open the link in Telegram and press **Start**. The relay rejects attempts to pair another person’s workspace account from the wrong named computer profile.
5. The paired app must stay running. Telegram `/on`, `/online`, or `on` starts that computer's timer and required screen captures. `/off`, `/offline`, `/break`, or `off` stops them. Commands sent while the app is offline are queued until it reconnects.

To post tracker status in a Telegram group, add the connected bot to the group and send `/setgroup@YourBotName` there from a Telegram account linked to the workspace. Starting tracking posts `Name: ON`; pausing posts `Name: Off`. To control a linked member’s computer from the group, send `/on@YourBotName` or `/off@YourBotName`; the bot routes the command to the computer paired to the sender’s Telegram account. The dashboard and workspace member totals show time for the current local calendar day and reset at midnight; daily and weekly reports continue to use the saved work sessions. The relay must be redeployed for group announcements and group commands to work across paired computers.

Use the same bot token only through the relay after setup; the relay switches it to Telegram webhooks. Keep the admin token private. The relay stores Telegram IDs, workspace usernames, online state, and queued commands in its persistent data file. Screenshots remain on each user's computer.

### Render setup

1. Push this project to a GitHub repository that Render can access. Keep `.env`, `relay/data/`, and any real bot/admin tokens out of Git.
2. In Render, select **New → Web Service**, connect the repository, and use the repository root.
3. Set **Build Command** to `npm install --omit=dev` and **Start Command** to `npm run relay`.
4. Choose a paid web service plan and add a persistent disk. The relay's JSON database must survive restarts; Render's free filesystem is temporary and free web services do not support persistent disks.
5. Set the disk mount path to `/var/data`, then add these environment variables:
   - `DATA_DIR` = `/var/data`
   - `RELAY_ADMIN_TOKEN` = a long random secret (generate locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
   - `PUBLIC_URL` = the HTTPS `onrender.com` URL shown for your service, without a trailing slash
6. Add `/health` as the health check path if Render offers that field, then create the service and wait for it to become live.
7. Open `https://YOUR-SERVICE.onrender.com/health`. It should return JSON containing `"ok":true`.
8. In the owner app, open **Telegram connection**, enter the relay URL and admin token, and choose **Verify administrator**. Then enter the bot token in the unlocked admin controls and choose **Connect bot to relay**.
9. Add each teammate from **Workspace** and share their Telegram invite. After they press **Start**, they install the current desktop app, enter the relay URL and their Telegram username, generate a computer link, and open it in Telegram. Teammates never need the admin token or bot token.

Do not set `PORT` manually; Render provides it and the relay listens on that port. Render's web services provide public HTTPS and TLS for the `onrender.com` hostname.

### If relay members or Telegram links disappear after a restart

The relay database lives at `${DATA_DIR}/relay.json`. Render's service filesystem is temporary unless a persistent disk is mounted. In Render, open the service's **Disks** settings and confirm a disk is mounted at `/var/data`; in **Environment**, confirm `DATA_DIR=/var/data`. Save and redeploy, then verify `/health` reports `"persistentDataDirConfigured":true` and `"databasePresent":true`. This field confirms the app is using the configured path; confirm the disk mount in Render as well. The relay also keeps a `relay.json.bak` backup beside the database on that disk. The relay now refuses to silently replace an unreadable database with an empty one and attempts recovery from that backup.

If the relay previously ran without a persistent disk and Render has restarted or redeployed it, its old relay database may already be gone and cannot be recovered from the temporary filesystem. The owner desktop may still have its local workspace member list. After the disk is mounted, open the owner app, reconnect the relay using the same URL, admin token, and bot token, then add or re-invite any missing members and have them press **Start** on their invite link again. Desktop tasks and screenshots are stored separately on each PC and are not backed up to the relay.

## Screenshots and data

Screenshot capture is required and cannot be disabled. The app saves one screen capture when tracking starts and another every five minutes while tracking is active. Captures stop when tracking is paused and are available in the **Screenshots** tab. Task data and screenshots are stored under Electron's `userData/tracker-data` folder for the current Windows user. The desktop app keeps a previous-state backup beside `state.json` and attempts recovery if the current state file becomes unreadable; keep both files when troubleshooting.

## Reports and assistant

Use **Reports → Export PDF** to save a local PDF report, or use the **End of week** section to review weekly time and tasks and export a weekly PDF. **Email report** sends a text summary through an SMTP server you provide; credentials are used only for that send and are not saved. The built-in assistant answers simple questions using local task and timer data and does not call an AI service.

## Notes

- Time is tracked only between Start and Stop (or Telegram `/online` and `/break`). A running session is stopped when the app closes.
- The pairing code expires in ten minutes.
- Use screenshot capture only with appropriate notice and consent from anyone whose screen may be recorded.
