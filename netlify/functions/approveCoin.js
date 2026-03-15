// netlify/functions/approveCoin.js
// Sends FCM push notification when a Coin Add transaction is approved.
// Requires FIREBASE_SERVICE_ACCOUNT env variable set in Netlify dashboard.

const { GoogleAuth } = require('google-auth-library');

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { token, amount } = body;
    if (!token || amount === undefined) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing token or amount' }) };
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch {
        return { statusCode: 500, body: JSON.stringify({ error: 'Invalid FIREBASE_SERVICE_ACCOUNT env variable' }) };
    }

    const projectId = serviceAccount.project_id;

    try {
        const auth = new GoogleAuth({
            credentials: serviceAccount,
            scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
        });

        const client = await auth.getClient();
        const { token: accessToken } = await client.getAccessToken();

        const message = {
            message: {
                token: token,
                notification: {
                    title: 'Payment Successful',
                    body: `${amount} gold successfully credited to your wallet ✅`,
                },
                // BUG FIX: android.priority MUST be at the android level, NOT inside android.notification
                // Previously "priority: HIGH" was inside android.notification which FCM silently ignores
                // This caused messages to arrive at normal priority (no heads-up / no sound on Android)
                android: {
                    priority: 'HIGH',           // ← controls delivery priority (was missing at this level)
                    ttl: '60s',                 // message expires after 60s if device offline
                    notification: {
                        sound: 'default',
                        channel_id: 'coin_add_channel',
                        notification_priority: 'PRIORITY_HIGH',  // ← controls how notification displays
                        visibility: 'PUBLIC',
                        default_sound: true,
                        default_vibrate_timings: true,
                    },
                },
                data: {
                    type: 'coin_add',
                    amount: String(amount),
                },
            },
        };

        const fcmRes = await fetch(
            `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify(message),
            }
        );

        const fcmData = await fcmRes.json();

        if (!fcmRes.ok) {
            console.error('FCM error:', fcmData);
            return { statusCode: 500, body: JSON.stringify({ error: 'FCM send failed', details: fcmData }) };
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, messageId: fcmData.name }) };

    } catch (err) {
        console.error('approveCoin error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
