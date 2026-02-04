const express = require('express');
const cors = require('cors');
const ZK = require("zkteco-js");
const https = require("https");
const schedule = require("node-schedule");

const app = express();
const PORT = 3000;

// --- AUTOMATIC DAILY SYNC CONFIGURATION ---
let lastAutoSyncAttempt = null;
let lastAutoSyncSuccess = null;
let autoSyncEnabled = true; // Can be toggled via API

// --- DEVICE CONFIGURATION ---
let DEVICE_IP = "192.168.18.144";
let DEVICE_PORT = 4370;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Global process error handlers to prevent crashes from library bugs
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

let isDeviceBusy = false;
let lastBusyReset = Date.now();
let cooldownUntil = 0; // Timestamp until which we should not hit the device

// --- HELPER LOGIC ---

// Robust wrapper for ZK operations to handle timeouts and crashes
async function executeZKAction(action) {
    const now = Date.now();
    // 1. Check Cool Down (after errors)
    if (now < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - now) / 1000);
        throw new Error(`Device recovery in progress... Please wait ${remaining}s`);
    }

    // 2. Auto-reset busy state if stuck for more than 40 seconds
    if (isDeviceBusy && (now - lastBusyReset > 40000)) {
        console.warn('[ZK] Device busy state stuck - performing emergency reset');
        isDeviceBusy = false;
    }

    if (isDeviceBusy) throw new Error('Device is busy. Please try again in 5-10 seconds.');

    isDeviceBusy = true;
    lastBusyReset = now;

    const zk = new ZK(DEVICE_IP, DEVICE_PORT, 10000); // 10s timeout
    try {
        console.log(`[ZK] Connecting to ${DEVICE_IP}:${DEVICE_PORT}...`);
        await zk.createSocket();
        const result = await action(zk);
        return result;
    } catch (err) {
        let errMsg = 'Unknown Communication Error';
        if (err && err.message) {
            errMsg = err.message;
        } else if (typeof err === 'object') {
            try { errMsg = JSON.stringify(err); } catch (e) { errMsg = String(err); }
        } else if (err) {
            errMsg = String(err);
        }
        console.error('[ZK] Action Error:', errMsg);

        // After ANY error, trigger a 15-second cool down period
        console.warn('[ZK] Triggering 15s cool down to allow firmware reset');
        cooldownUntil = Date.now() + 15000;

        throw new Error(errMsg);
    } finally {
        try {
            await zk.disconnect();
        } catch (e) {
            // Socket already closed
        }
        isDeviceBusy = false;
    }
}

const calculateStats = (records) => {
    const stats = {};
    const currentStatus = {};

    const sortedRecords = [...records].map(log => {
        const ts = log.record_time || log.recordTime || log.timestamp;
        return { ...log, date: new Date(ts), userId: String(log.user_id || log.uid || log.userId) };
    }).sort((a, b) => a.date - b.date);

    sortedRecords.forEach(log => {
        const uid = log.userId;
        const y = log.date.getFullYear();
        const m = String(log.date.getMonth() + 1).padStart(2, '0');
        const d = String(log.date.getDate()).padStart(2, '0');
        const dateKey = `${y}-${m}-${d}`;

        const type = log.state || log.status;
        const isCheckOut = type === 1;

        if (!stats[uid]) stats[uid] = {};
        if (!stats[uid][dateKey]) stats[uid][dateKey] = { firstIn: null, lastOut: null, totalMs: 0, lastCheckIn: null, rawLogs: [] };

        const dayStat = stats[uid][dateKey];
        dayStat.rawLogs.push({
            time: log.date.toLocaleTimeString('en-GB', { hour12: false }), // HH:mm:ss
            type: isCheckOut ? 'check_out' : 'check_in'
        });

        if (!isCheckOut) {
            if (!dayStat.firstIn) dayStat.firstIn = log.date;
            dayStat.lastCheckIn = log.date;
            currentStatus[uid] = { state: 'In', time: log.date };
        } else {
            dayStat.lastOut = log.date;
            if (dayStat.lastCheckIn) {
                dayStat.totalMs += (log.date - dayStat.lastCheckIn);
                dayStat.lastCheckIn = null;
            }
            currentStatus[uid] = { state: 'Out', time: log.date };
        }
    });

    const formattedStats = {};
    for (const uid in stats) {
        formattedStats[uid] = {};
        for (const date in stats[uid]) {
            const s = stats[uid][date];
            const hours = Math.floor(s.totalMs / 3600000);
            const mins = Math.floor((s.totalMs % 3600000) / 60000);
            formattedStats[uid][date] = {
                duration: `${hours}h ${mins}m`,
                firstIn: s.firstIn ? s.firstIn.toLocaleTimeString('en-GB', { hour12: false }) : '-',
                lastOut: s.lastOut ? s.lastOut.toLocaleTimeString('en-GB', { hour12: false }) : '-',
                totalMs: s.totalMs,
                logs: s.rawLogs
            };
        }
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const uid in currentStatus) {
        const pDate = currentStatus[uid].time;
        const punchDateStr = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}-${String(pDate.getDate()).padStart(2, '0')}`;
        if (currentStatus[uid].state === 'In' && punchDateStr !== todayStr) {
            currentStatus[uid].state = 'Out';
        }
    }

    return { dailyStats: formattedStats, activeStatus: currentStatus };
};

async function getUnifiedData(filterType, filterValue) {
    try {
        const { logsRaw, usersRaw } = await executeZKAction(async (zk) => {
            const l = await zk.getAttendances();
            const u = await zk.getUsers();
            return { logsRaw: l, usersRaw: u };
        });

        const userList = Array.isArray(usersRaw) ? usersRaw : (usersRaw && usersRaw.data ? usersRaw.data : []);
        const userMap = {};
        userList.forEach(u => {
            const id = u.userId || u.user_id || u.uid;
            userMap[String(id)] = u.name || 'Unknown';
        });

        const attendanceList = Array.isArray(logsRaw) ? logsRaw : (logsRaw && logsRaw.data ? logsRaw.data : []);

        // Process formatted logs
        let filteredLogs = attendanceList.map(log => {
            const ts = log.record_time || log.recordTime || log.timestamp;
            const userId = log.user_id || log.uid || log.deviceUserId || 'N/A';
            const logDate = new Date(ts);
            return {
                uid: userId,
                userName: userMap[String(userId)] || 'Unknown',
                timestamp: logDate.toISOString(),
                _date: logDate, // Temporary for filtering
                status: log.state || log.status || 0,
                deviceSN: log.deviceSN || 'ZK-Device'
            };
        });

        // Apply filters (Default to today's date if no filter provided)
        const activeFilterType = filterType || 'date';
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const activeFilterValue = filterValue || todayStr;

        filteredLogs = filteredLogs.filter(log => {
            const d = log._date;
            if (activeFilterType === 'date') {
                const t = new Date(activeFilterValue + 'T00:00:00');
                return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
            } else if (activeFilterType === 'month') {
                const [y, m] = activeFilterValue.split('-');
                return d.getFullYear() === parseInt(y) && (d.getMonth() + 1) === parseInt(m);
            } else if (activeFilterType === 'year') {
                return d.getFullYear() === parseInt(activeFilterValue);
            }
            return true; // Match all for filterType === ""
        });

        // 4. Calculate Stats & Status
        const stats = calculateStats(attendanceList);

        // 5. Filter the summary to only include requested date/range
        const filteredSummary = {};
        const activeSummaryFilterType = filterType || 'date';
        const activeSummaryFilterValue = filterValue || todayStr;

        for (const uid in stats.dailyStats) {
            filteredSummary[uid] = {};
            for (const dateKey in stats.dailyStats[uid]) {
                // dateKey is \"YYYY-MM-DD\"
                let match = false;
                if (activeSummaryFilterType === 'date') match = (dateKey === activeSummaryFilterValue);
                else if (activeSummaryFilterType === 'month') match = dateKey.startsWith(activeSummaryFilterValue);
                else if (activeSummaryFilterType === 'year') match = dateKey.startsWith(activeSummaryFilterValue);
                else match = true; // For \"All Records\"

                if (match) {
                    filteredSummary[uid][dateKey] = stats.dailyStats[uid][dateKey];
                }
            }
            // Only include users who have data for this filter
            if (Object.keys(filteredSummary[uid]).length === 0) {
                delete filteredSummary[uid];
            }
        }

        // 6. Cleanup for response
        const finalLogs = filteredLogs.map(({ _date, ...rest }) => rest).reverse();

        return {
            success: true,
            count: finalLogs.length,
            device: DEVICE_IP,
            filtered: true,
            filterInfo: { type: activeFilterType, value: activeFilterValue },
            data: finalLogs,
            summary: filteredSummary,
            employeeStatus: stats.activeStatus,
            userNames: userMap
        };

    } catch (err) {
        console.error('[API] getUnifiedData Error:', err.message);
        throw err;
    }
}

// --- API ENDPOINTS ---

app.get('/api/users', async (req, res) => {
    try {
        const users = await executeZKAction(async (zk) => {
            return await zk.getUsers();
        });

        const userList = Array.isArray(users) ? users : (users && users.data ? users.data : []);
        const formatted = userList.map(u => ({
            uid: u.uid,
            userId: u.user_id || u.userId || u.uid,
            name: u.name || 'Unknown',
            role: u.role || 0,
            cardNo: u.cardno || ''
        }));
        res.json({ success: true, data: formatted });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    } finally {
        isDeviceBusy = false;
    }
});

// Helper for robust HTTPS POST with IP fallback
async function postToCloud(payload) {
    const CLOUD_HOST = 'demo.jantrah.com';
    const CLOUD_IP = '72.60.181.228';
    const CLOUD_PATH = '/project-mgm/web/hr/api/import-attendance';

    const tryRequest = (target, useIP = false) => {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: target,
                port: 443,
                path: CLOUD_PATH,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Host': CLOUD_HOST, // Crucial for virtual hosting on direct IP
                    'User-Agent': 'JTech-Attendance-Server/1.0',
                    'Content-Length': Buffer.byteLength(JSON.stringify(payload))
                }
            };

            // If we are using the IP direct, allow self-signed/mismatched certs for this specific call
            if (useIP) {
                options.rejectUnauthorized = false;
            }

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });

            req.on('error', reject);
            req.write(JSON.stringify(payload));
            req.end();
        });
    };

    try {
        console.log(`[SYNC] Primary attempt: https://${CLOUD_HOST}...`);
        return await tryRequest(CLOUD_HOST);
    } catch (err) {
        console.warn(`[SYNC] Primary failed: ${err.message}. Trying IP fallback: ${CLOUD_IP}...`);
        return await tryRequest(CLOUD_IP, true);
    }
}

// --- AUTOMATED DAILY SYNC ---
// Helper function to get yesterday's date in YYYY-MM-DD format
function getYesterdayDateString() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Main automated sync function
async function performAutoDailySync() {
    const targetDate = getYesterdayDateString();
    console.log(`\n========================================`);
    console.log(`[AUTO-SYNC] Starting automated daily sync for ${targetDate}`);
    console.log(`[AUTO-SYNC] Time: ${new Date().toLocaleString()}`);
    console.log(`========================================`);

    lastAutoSyncAttempt = new Date().toISOString();

    if (!autoSyncEnabled) {
        console.log('[AUTO-SYNC] Skipped - Auto sync is disabled');
        return { success: false, reason: 'Auto sync disabled' };
    }

    try {
        // Fetch yesterday's data
        const result = await getUnifiedData('date', targetDate);

        if (!result.success) {
            console.error('[AUTO-SYNC] Failed to fetch data:', result.message);
            return { success: false, reason: result.message };
        }

        // Build the payload
        const externalPayload = [];
        for (const uid in result.summary) {
            for (const date in result.summary[uid]) {
                const s = result.summary[uid][date];

                // Format total_time_worked from "Xh Ym" to "HH:mm:ss"
                const totalMs = s.totalMs || 0;
                const h = Math.floor(totalMs / 3600000);
                const m = Math.floor((totalMs % 3600000) / 60000);
                const s_time = Math.floor((totalMs % 60000) / 1000);
                const formattedTotalTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s_time).padStart(2, '0')}`;

                externalPayload.push({
                    employee_code_id: uid,
                    name: result.userNames[uid] || 'Unknown',
                    date: date,
                    first_Check_In: s.firstIn,
                    last_check_out: s.lastOut,
                    total_time_worked: formattedTotalTime,
                    logs: s.logs || []
                });
            }
        }

        if (externalPayload.length === 0) {
            console.log(`[AUTO-SYNC] No records found for ${targetDate}. Skipping sync.`);
            lastAutoSyncSuccess = {
                date: new Date().toISOString(),
                targetDate,
                status: 'skipped',
                reason: 'No records for this date'
            };
            return { success: true, skipped: true, reason: 'No records' };
        }

        console.log(`[AUTO-SYNC] Found ${externalPayload.length} employee records for ${targetDate}`);
        console.log(`[AUTO-SYNC] Posting to cloud...`);

        // Post to cloud
        const syncResult = await postToCloud(externalPayload);

        console.log(`[AUTO-SYNC] Cloud Response Status: ${syncResult.status}`);
        console.log(`[AUTO-SYNC] Cloud Response Body: ${syncResult.body}`);

        const isSuccess = syncResult.status >= 200 && syncResult.status < 300;

        lastAutoSyncSuccess = {
            date: new Date().toISOString(),
            targetDate,
            status: isSuccess ? 'success' : 'failed',
            recordsSynced: externalPayload.length,
            httpStatus: syncResult.status,
            response: syncResult.body
        };

        if (isSuccess) {
            console.log(`[AUTO-SYNC] ✅ Successfully synced ${externalPayload.length} records for ${targetDate}`);
        } else {
            console.error(`[AUTO-SYNC] ❌ Cloud sync failed with status ${syncResult.status}`);
        }

        return { success: isSuccess, recordsSynced: externalPayload.length };

    } catch (err) {
        let errMsg = 'Unknown error';
        if (err && err.message) {
            errMsg = err.message;
        } else if (typeof err === 'object') {
            try { errMsg = JSON.stringify(err); } catch (e) { errMsg = String(err); }
        } else if (err) {
            errMsg = String(err);
        }
        console.error(`[AUTO-SYNC] ❌ Error during auto sync:`, errMsg);
        lastAutoSyncSuccess = {
            date: new Date().toISOString(),
            targetDate,
            status: 'error',
            error: errMsg
        };
        return { success: false, error: errMsg };
    }
}

// Schedule the auto sync to run every day at 00:00:01 (1 second after midnight)
// This ensures we're syncing the PREVIOUS day's data
const dailySyncJob = schedule.scheduleJob('1 0 0 * * *', async () => {
    console.log('[SCHEDULER] Midnight trigger activated!');
    await performAutoDailySync();
});

console.log('[SCHEDULER] 🕛 Daily auto-sync scheduled for 00:00:01 every day');

// API endpoint to check auto-sync status
app.get('/api/auto-sync/status', (req, res) => {
    res.json({
        success: true,
        enabled: autoSyncEnabled,
        lastAttempt: lastAutoSyncAttempt,
        lastResult: lastAutoSyncSuccess,
        nextScheduledRun: dailySyncJob.nextInvocation() ? dailySyncJob.nextInvocation().toISOString() : null
    });
});

// API endpoint to toggle auto-sync
app.post('/api/auto-sync/toggle', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') {
        autoSyncEnabled = enabled;
    } else {
        autoSyncEnabled = !autoSyncEnabled;
    }
    res.json({ success: true, enabled: autoSyncEnabled });
});

// API endpoint to manually trigger yesterday's sync (for testing)
app.post('/api/auto-sync/run-now', async (req, res) => {
    try {
        console.log('[MANUAL-TRIGGER] Manual auto-sync triggered via API');
        const result = await performAutoDailySync();
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API endpoint to sync a specific date manually
app.post('/api/auto-sync/sync-date', async (req, res) => {
    try {
        const { date } = req.body; // Expected format: YYYY-MM-DD
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ success: false, message: 'Invalid date format. Use YYYY-MM-DD' });
        }

        console.log(`[MANUAL-SYNC] Manual sync triggered for date: ${date}`);

        const result = await getUnifiedData('date', date);
        if (!result.success) {
            return res.status(500).json({ success: false, message: result.message });
        }

        const externalPayload = [];
        for (const uid in result.summary) {
            for (const dateKey in result.summary[uid]) {
                const s = result.summary[uid][dateKey];
                const totalMs = s.totalMs || 0;
                const h = Math.floor(totalMs / 3600000);
                const m = Math.floor((totalMs % 3600000) / 60000);
                const s_time = Math.floor((totalMs % 60000) / 1000);
                const formattedTotalTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s_time).padStart(2, '0')}`;

                externalPayload.push({
                    employee_code_id: uid,
                    name: result.userNames[uid] || 'Unknown',
                    date: dateKey,
                    first_Check_In: s.firstIn,
                    last_check_out: s.lastOut,
                    total_time_worked: formattedTotalTime,
                    logs: s.logs || []
                });
            }
        }

        if (externalPayload.length === 0) {
            return res.json({ success: false, message: `No records found for ${date}` });
        }

        const syncResult = await postToCloud(externalPayload);
        const isSuccess = syncResult.status >= 200 && syncResult.status < 300;

        let responseJson = {};
        try { responseJson = JSON.parse(syncResult.body); } catch (e) { responseJson = { raw: syncResult.body }; }

        res.json({
            success: isSuccess,
            date,
            recordsSynced: externalPayload.length,
            externalStatus: syncResult.status,
            externalResponse: responseJson
        });

    } catch (err) {
        console.error('[MANUAL-SYNC] Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Update device configuration
app.post('/api/config', (req, res) => {
    const { ip, port } = req.body;
    if (ip) DEVICE_IP = ip;
    if (port) DEVICE_PORT = parseInt(port);
    res.json({ success: true, ip: DEVICE_IP, port: DEVICE_PORT });
});

// External API Cloud Sync
app.post('/api/sync', async (req, res) => {
    try {
        const { type, value } = req.body;
        const result = await getUnifiedData(type, value);

        if (!result.success) {
            return res.status(500).json(result);
        }

        const externalPayload = [];
        for (const uid in result.summary) {
            for (const date in result.summary[uid]) {
                const s = result.summary[uid][date];

                // Format total_time_worked from "Xh Ym" to "HH:mm:ss"
                const totalMs = s.totalMs || 0;
                const h = Math.floor(totalMs / 3600000);
                const m = Math.floor((totalMs % 3600000) / 60000);
                const s_time = Math.floor((totalMs % 60000) / 1000);
                const formattedTotalTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s_time).padStart(2, '0')}`;

                externalPayload.push({
                    employee_code_id: uid,
                    date: date,
                    first_Check_In: s.firstIn,
                    last_check_out: s.lastOut,
                    total_time_worked: formattedTotalTime,
                    logs: s.logs || []
                });
            }
        }

        if (externalPayload.length === 0) {
            return res.json({ success: false, message: "No data to sync for selected filter" });
        }

        console.log(`[SYNC] Dispatching ${externalPayload.length} records to robust sync engine...`);
        const syncResult = await postToCloud(externalPayload);

        console.log(`[SYNC] External Response Status: ${syncResult.status}`);
        console.log(`[SYNC] External Response Body: ${syncResult.body}`);

        let responseJson = {};
        try { responseJson = JSON.parse(syncResult.body); } catch (e) { responseJson = { raw: syncResult.body }; }

        res.json({
            success: syncResult.status >= 200 && syncResult.status < 300,
            recordsSynced: externalPayload.length,
            externalStatus: syncResult.status,
            externalResponse: responseJson
        });

    } catch (err) {
        console.error('[SYNC] Global Sync Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// The main GET endpoint
app.get('/api/attendance', async (req, res) => {
    try {
        const { type, value, ip, port } = req.query;
        // Optionally allow transient IP/Port for testing
        const targetIp = ip || DEVICE_IP;
        const targetPort = port ? parseInt(port) : DEVICE_PORT;

        // We need to pass targetIp/targetPort to getUnifiedData if we want it truly dynamic per-request
        // but for now let's just use the global ones as requested for "stickiness"
        const result = await getUnifiedData(type, value);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n✅ JTech Attendance API Ready!`);
    console.log(`🚀 Unified End Point: http://localhost:${PORT}/api/attendance`);
    console.log(`👥 User List End Point: http://localhost:${PORT}/api/users\n`);
});
