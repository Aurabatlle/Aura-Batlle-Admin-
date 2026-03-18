/**
 * notify.js — Netlify Serverless Function
 * ─────────────────────────────────────────────────────────────────────────────
 * File location in your project:
 *   netlify/functions/notify.js
 *
 * Called by:
 *   hostmatch.html  →  sendNotification(matchId, type, reason)
 *   admin-matches.html → sendNotification(matchId, type, reason)
 *
 * What it does:
 *   1. Reads the match from Firebase to get all joined player UIDs
 *   2. Reads each player's FCM token from /users/{uid}/fcmToken
 *   3. Sends an FCM push notification to all tokens via Firebase Cloud Messaging
 *   4. Returns { sent: N } — number of tokens successfully pushed
 *
 * Notification types handled:
 *   match_started   — "Match is now LIVE! Room details ready."
 *   room_details    — "Room ID & Password are now available."
 *   match_cancelled — "Match has been cancelled. Reason: {reason}"
 *   result_pending  — "Match ended. Results will be announced soon."
 *
 * Environment variables required in Netlify dashboard:
 *   FIREBASE_DATABASE_URL  — e.g. https://aura-battle-main-default-rtdb.firebaseio.com
 *   FIREBASE_SERVER_KEY    — FCM Server Key from Firebase Console →
 *                            Project Settings → Cloud Messaging → Server Key
 *                            (Legacy API — v1 requires service account, see note below)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO GET YOUR FCM SERVER KEY:
 *   Firebase Console → Project Settings → Cloud Messaging tab
 *   Copy "Server key" under "Cloud Messaging API (Legacy)"
 *   If legacy is disabled, enable it or see FCM v1 note at bottom of file.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

// ── Firebase REST helper ──────────────────────────────────────────────────────
// Reads a path from Firebase Realtime DB using the REST API (no SDK needed)
async function firebaseGet(path) {
    const dbUrl   = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, '');
    const url     = `${dbUrl}/${path}.json`;
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('Firebase parse error: ' + e.message)); }
            });
        }).on('error', reject);
    });
}

// ── Send one FCM push via Legacy HTTP API ─────────────────────────────────────
async function sendFcmPush(tokens, title, body, data) {
    if (!tokens || tokens.length === 0) return 0;

    const serverKey = process.env.FIREBASE_SERVER_KEY;
    if (!serverKey) {
        console.warn('[notify] FIREBASE_SERVER_KEY not set — skipping FCM push');
        return 0;
    }

    // FCM allows max 1000 tokens per request — chunk if needed
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 1000) {
        chunks.push(tokens.slice(i, i + 1000));
    }

    let totalSent = 0;

    for (const chunk of chunks) {
        const payload = JSON.stringify({
            registration_ids: chunk,
            notification: {
                title,
                body,
                sound: 'default',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: {
                priority: 'high',
                notification: {
                    sound:        'default',
                    priority:     'high',
                    channelId:    'aura_battle_channel'
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1
                    }
                }
            }
        });

        const result = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'fcm.googleapis.com',
                path:     '/fcm/send',
                method:   'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `key=${serverKey}`,
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch(e) { resolve({ failure: chunk.length }); }
                });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        totalSent += result.success || 0;
        if (result.failure > 0) {
            console.warn(`[notify] ${result.failure} tokens failed in this chunk`);
        }
    }

    return totalSent;
}

// ── Collect all FCM tokens for a match ───────────────────────────────────────
async function getTokensForMatch(matchId, matchData) {
    const uids   = new Set();
    const isSolo = (matchData.entryType || '').toLowerCase() === 'solo';

    if (isSolo) {
        // Solo: players/{userId} = { userId, inGameName }
        const players = matchData.players || {};
        Object.values(players).forEach(p => {
            const uid = p.userId || p.uid;
            if (uid) uids.add(uid);
        });
    } else {
        // Team: teams/{teamId} = { leaderId, members: { uid: ign } }
        const teams = matchData.teams || {};
        Object.values(teams).forEach(team => {
            if (team.leaderId) uids.add(team.leaderId);
            // Also notify all team members
            Object.keys(team.members || {}).forEach(uid => uids.add(uid));
        });
    }

    if (uids.size === 0) return [];

    // Fetch FCM tokens for all UIDs in parallel
    const tokenPromises = [...uids].map(async uid => {
        try {
            const token = await firebaseGet(`users/${uid}/fcmToken`);
            return typeof token === 'string' && token.length > 10 ? token : null;
        } catch (e) {
            console.warn(`[notify] Could not get token for uid ${uid}:`, e.message);
            return null;
        }
    });

    const results = await Promise.all(tokenPromises);
    return results.filter(Boolean); // remove nulls
}

// ── Notification message builder ──────────────────────────────────────────────
function buildMessage(type, matchTitle, reason) {
    const title = matchTitle || 'Aura Battle';

    switch (type) {
        case 'match_started':
            return {
                title: '🔴 Match is LIVE!',
                body:  `${title} has started. Check room details now!`
            };
        case 'room_details':
            return {
                title: '🔑 Room Details Available',
                body:  `Room ID & Password are now set for ${title}. Tap to view.`
            };
        case 'match_cancelled':
            return {
                title: '❌ Match Cancelled',
                body:  reason
                    ? `${title} was cancelled. Reason: ${reason}`
                    : `${title} has been cancelled. Entry fee refunded.`
            };
        case 'result_pending':
            return {
                title: '🏁 Match Ended',
                body:  `${title} has ended. Results will be announced soon.`
            };
        default:
            return {
                title: 'Aura Battle Update',
                body:  `Update for match: ${title}`
            };
    }
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event, context) {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Invalid JSON body' })
        };
    }

    const { matchId, type, reason, sender, adminId } = body;

    if (!matchId || !type) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'matchId and type are required' })
        };
    }

    console.log(`[notify] matchId=${matchId} type=${type} sender=${sender||'hoster'} adminId=${adminId||'—'}`);

    try {
        // 1. Fetch match data from Firebase
        const matchData = await firebaseGet(`matches/${matchId}`);
        if (!matchData) {
            console.warn(`[notify] Match ${matchId} not found in DB`);
            return {
                statusCode: 200,
                body: JSON.stringify({ sent: 0, warning: 'Match not found' })
            };
        }

        // 2. Collect FCM tokens
        const tokens = await getTokensForMatch(matchId, matchData);
        console.log(`[notify] Found ${tokens.length} tokens for match ${matchId}`);

        if (tokens.length === 0) {
            return {
                statusCode: 200,
                body: JSON.stringify({ sent: 0, warning: 'No FCM tokens found' })
            };
        }

        // 3. Build message
        const { title: msgTitle, body: msgBody } = buildMessage(
            type,
            matchData.title,
            reason
        );

        // 4. Send FCM push
        const sent = await sendFcmPush(tokens, msgTitle, msgBody, {
            matchId,
            type,
            sender: sender || 'hoster'
        });

        console.log(`[notify] Sent ${sent} / ${tokens.length} pushes`);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sent, total: tokens.length })
        };

    } catch (err) {
        console.error('[notify] Error:', err.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP CHECKLIST
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Place this file at:
 *      netlify/functions/notify.js
 *
 * 2. In Netlify dashboard → Site → Environment Variables, add:
 *      FIREBASE_DATABASE_URL  = https://aura-battle-main-default-rtdb.firebaseio.com
 *      FIREBASE_SERVER_KEY    = your FCM server key (see below)
 *
 * 3. Get FCM Server Key:
 *      Firebase Console → Project Settings → Cloud Messaging
 *      Copy "Server key" under "Cloud Messaging API (Legacy)"
 *      If not visible, click the 3-dot menu → "Manage API in Google Cloud Console"
 *      Enable it there, then come back — the key will appear.
 *
 * 4. In your Android app, make sure each user's FCM token is saved to:
 *      /users/{userId}/fcmToken
 *    Your HomeActivity already does this via fetchAndSaveFcmToken().
 *
 * 5. In your Android app's notification channel, use:
 *      channelId = "aura_battle_channel"
 *    to match the android.notification.channelId sent above.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FCM v1 NOTE (if Legacy API is disabled):
 * ─────────────────────────────────────────────────────────────────────────────
 * If Google has disabled the Legacy FCM API for your project, you need to use
 * FCM HTTP v1 which requires a Service Account. Steps:
 *   1. Firebase Console → Project Settings → Service Accounts
 *   2. Click "Generate new private key" → download JSON
 *   3. Add the JSON contents as FIREBASE_SERVICE_ACCOUNT env variable
 *   4. Use googleapis npm package to get an OAuth2 access token, then call:
 *      POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
 *      with Authorization: Bearer {access_token}
 * ─────────────────────────────────────────────────────────────────────────────
 */
