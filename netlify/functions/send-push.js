const { GoogleAuth } = require('google-auth-library');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { target, title, body, image, data } = JSON.parse(event.body);

    if (!target || !title || !body) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'target, title, and body are required.' }) };
    }

    // ✅ Key is read from Netlify Environment Variable — never exposed in code
    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });

    const client = await auth.getClient();
    const tokenData = await client.getAccessToken();
    const accessToken = tokenData.token;
    const projectId = SERVICE_ACCOUNT.project_id;

    const isTopic = target.startsWith('/topics/');
    const messageTarget = isTopic
      ? { topic: target.replace('/topics/', '') }
      : { token: target };

    const message = {
      message: {
        ...messageTarget,
        notification: {
          title,
          body,
          ...(image ? { image } : {})
        },
        ...(data && Object.keys(data).length > 0
          ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) }
          : {}),
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            click_action: 'FLUTTER_NOTIFICATION_CLICK'
          }
        }
      }
    };

    const fcmRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      }
    );

    const result = await fcmRes.json();

    if (!fcmRes.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: result.error || result }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: result.name }) };

  } catch (err) {
    console.error('send-push error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
