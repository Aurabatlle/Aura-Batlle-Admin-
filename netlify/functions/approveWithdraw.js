// netlify/functions/approveWithdraw.js
// Sends FCM push notification when a Withdrawal is approved.
// Requires FIREBASE_SERVICE_ACCOUNT env variable set in Netlify dashboard.
//
// Supported types:
//   "UPI Withdrawal"          → UPI success message
//   "Amazon Withdrawal"       → Amazon gift card message
//   "Google Play Withdrawal"  → Google Play gift card message

const { GoogleAuth } = require('google-auth-library');

const MESSAGES = {
    'UPI Withdrawal': {
        title: 'Withdrawal Successful',
        body: (amount) => `Your ${amount} ₹ successfully sent to your UPI account ✅`,
    },
    'Amazon Withdrawal': {
        title: 'Withdrawal Successful',
        body: (amount) => `Your ${amount} ₹ Amazon gift card withdrawal successful ✅\n\nVisit your transaction history to get code 🎁`,
    },
    'Google Play Withdrawal': {
        title: 'Withdrawal Successful',
        body: (amount) => `Your ${amount} ₹ Google Play gift card withdrawal successful ✅\n\nVisit your transaction history to get code 🎁`,
    },
};

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

    const { token, amount, type } = body;
    if (!token || amount === undefined || !type) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing token, amount or type' }) };
    }

    const msgTemplate = MESSAGES[type];
    if (!msgTemplate) {
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown withdrawal type: ${type}` }) };
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
                    title: msgTemplate.title,
                    body: msgTemplate.body(amount),
                },
                android: {
                    priority: 'HIGH',
                    ttl: '60s',
                    notification: {
                        sound: 'default',
                        channel_id: 'withdrawal_channel',
                        notification_priority: 'PRIORITY_HIGH',
                        visibility: 'PUBLIC',
                        default_sound: true,
                        default_vibrate_timings: true,
                    },
                },
                data: {
                    type: 'withdrawal',
                    withdrawal_type: type,
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
        console.error('approveWithdraw error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
