# Daily Attendance Sync Setup Guide

This guide explains how the automated daily attendance sync works and how to keep it running permanently on your Windows server.

## 1. How it Works
The system uses an internal scheduler (configured in `server.js`) that runs automatically at **00:00:01 (Midnight)** every day.

- **Trigger Time:** 00:00:01 AM daily.
- **Action:** Checks attendance logs for the **previous day**.
- **Condition:** If records exist, it pushes them to the cloud API. If no records exist, it skips.
- **Retry:** Includes automatic retry logic if the cloud server is unreachable.

## 2. Prerequisites
Ensure the necessary libraries are installed (these act as the engine for the scheduler).
```powershell
npm install node-schedule
```
*(This has already been installed in this project)*

## 3. Running Persistently (Recommended)
To ensure the sync runs every night, the server must be **running constantly**. If you close the command prompt, the sync will stop.
 
We recommend using **PM2**, a process manager that keeps your app running in the background and restarts it automatically if it crashes or if Windows restarts.

### Step 3.1: Install PM2
Open your terminal (Command Prompt or PowerShell) and run:
```powershell
npm install -g pm2
npm install pm2-windows-startup -g
pm2-startup install
```

### Step 3.2: Start the Server with PM2
Instead of `node server.js`, use this command:
```powershell
pm2 start server.js --name "zk-attendance"
```

### Step 3.3: Save the Process List
Freeze current process list for automatic respawn:
```powershell
pm2 save
```

Now, the attendance server will run in the background 24/7.

## 4. Monitoring & Management

### Check Status
See if the server is running:
```powershell
pm2 status
```

### View Logs
Check the logs to see sync activity:
```powershell
pm2 logs zk-attendance
```
*You will see `[AUTO-SYNC]` messages here every midnight.*

### Stop/Restart
```powershell
pm2 restart zk-attendance
pm2 stop zk-attendance
```

## 5. Manual Control (Optional)
If you need to trigger a sync manually (e.g., for testing or if the server was off at midnight), you can use the API:

**Trigger for Yesterday:**
```powershell
curl -X POST http://localhost:3000/api/auto-sync/run-now
```

**Trigger for Specific Date:**
```powershell
curl -X POST http://localhost:3000/api/auto-sync/sync-date -H "Content-Type: application/json" -d "{\"date\": \"2023-10-27\"}"
```
