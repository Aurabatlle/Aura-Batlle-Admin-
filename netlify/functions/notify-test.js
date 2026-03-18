const { GoogleAuth } = require('google-auth-library');

// Quick test: send a real FCM push to ONE hardcoded token
// Deploy this as a Netlify function, then call it from browser:
// fetch('/.netlify/functions/notify-test').then(r=>r.json()).then(console.log)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing FIREBASE_SERVICE_ACCOUNT env' }) };

    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = SERVICE_ACCOUNT.project_id;

    // ── Step 1: Get OAuth access token ───────────────────────────────────────
    let accessToken;
    try {
      const auth = new GoogleAuth({
        credentials: SERVICE_ACCOUNT,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging']
      });
      const client    = await auth.getClient();
      const tokenData = await client.getAccessToken();
      accessToken     = tokenData.token;
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ step: 'oauth', error: e.message }) };
    }

    // ── Step 2: Send to the real FCM token from your Firebase ────────────────
    // Replace with any real fcmToken from your /users node to test
    const TEST_TOKEN = 'e7skGuymThClorz22ai80u:APA91bHrUqgT8baDjotWh5AUvmk0uouuyDA5AFHIM9321MeGUVHdzZGTeDIhhA0HDUl6aXXI_njz1Gl8MofMk7jCZqTfH6eAvUx1Mskyb7gvyL3FEEIcoT0';

    const fcmBody = {
      message: {
        token: TEST_TOKEN,
        notification: {
          title: 'Test Notification',
          body:  'If you see this, FCM is working!'
        },
        data: {
          title: 'Test Notification',
          body:  'If you see this, FCM is working!',
          type:  'test',
          matchId: '0'
        },
        android: {
          priority: 'HIGH',
          notification: {
            sound:                 'default',
            channel_id:            'high_importance_channel',
            click_action:          'FLUTTER_NOTIFICATION_CLICK',
            notification_priority: 'PRIORITY_HIGH',
            visibility:            'PUBLIC'
          }
        }
      }
    };

    const fcmRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fcmBody)
      }
    );

    const fcmText = await fcmRes.text();
    let fcmJson;
    try { fcmJson = JSON.parse(fcmText); } catch (_) { fcmJson = null; }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        step:        'fcm_send',
        httpStatus:  fcmRes.status,
        ok:          fcmRes.ok,
        projectId,
        response:    fcmJson || fcmText
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
