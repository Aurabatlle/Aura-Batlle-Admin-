const { GoogleAuth } = require('google-auth-library');

// ── Firebase REST helpers ─────────────────────────────────────────────────────
async function firebaseGet(path, dbUrl) {
  const res = await fetch(`${dbUrl}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
  return res.json();
}

async function firebasePatch(path, dbUrl, data) {
  const res = await fetch(`${dbUrl}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Firebase PATCH failed: ${res.status}`);
  return res.json();
}

// ── FCM send (single token) ───────────────────────────────────────────────────
async function sendOne(accessToken, projectId, token, title, body, data = {}) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token,

          // FIX 1: Top-level notification block is required so Android shows
          // the notification in ALL app states (foreground/background/killed).
          notification: { title, body },

          // FIX 2: Also put title+body in data payload so Flutter's
          // onBackgroundMessage / onMessageOpenedApp can read them when
          // RemoteMessage.notification is null (app was killed).
          data: {
            ...Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, String(v)])
            ),
            title,
            body
          },

          android: {
            // FIX 3: FCM HTTP v1 expects uppercase "HIGH"
            priority: 'HIGH',

            notification: {
              sound: 'default',

              // FIX 4: channel_id must match the channel your Flutter app
              // creates. Change 'match_alerts' to your actual channel id.
              channel_id: 'match_alerts',

              click_action: 'FLUTTER_NOTIFICATION_CLICK',

              // FIX 5: Heads-up priority so notification pops up on screen
              notification_priority: 'PRIORITY_HIGH',
              visibility: 'PUBLIC'
            }
          }
        }
      })
    }
  );

  // FIX 6: Log full FCM error body — res.ok only checks HTTP 200, not the
  // FCM-level error (e.g. UNREGISTERED / INVALID_ARGUMENT inside a 200).
  if (!res.ok) {
    const errText = await res.text().catch(() => '(unreadable)');
    console.error(`[FCM] FAILED token=...${token.slice(-8)} status=${res.status} err=${errText}`);
    return false;
  }

  const json = await res.json().catch(() => null);
  if (json && json.error) {
    console.warn(`[FCM] ERROR token=...${token.slice(-8)} code=${json.error.code} msg=${json.error.message}`);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collect all real userIds from a match — works for BOTH Solo AND Team modes
// ─────────────────────────────────────────────────────────────────────────────
function collectUserIds(match) {
  const ids = new Set();

  if (match.players && typeof match.players === 'object') {
    Object.values(match.players).forEach(p => {
      if (p && p.userId) ids.add(p.userId);
    });
  }

  if (match.teams && typeof match.teams === 'object') {
    Object.values(match.teams).forEach(team => {
      if (!team) return;
      if (team.leaderId) ids.add(team.leaderId);
      if (team.members && typeof team.members === 'object') {
        Object.keys(team.members).forEach(uid => {
          if (!/^p\d+$/.test(uid)) ids.add(uid);
        });
      }
    });
  }

  return [...ids];
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env: FIREBASE_SERVICE_ACCOUNT' }) };
    if (!process.env.FIREBASE_DB_URL)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env: FIREBASE_DB_URL' }) };

    if (!event.body)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request body is empty.' }) };

    const { matchId, type, reason } = JSON.parse(event.body);
    if (!matchId || !type)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'matchId and type are required.' }) };

    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const DB_URL          = process.env.FIREBASE_DB_URL;

    const match = await firebaseGet(`matches/${matchId}`, DB_URL);
    if (!match)
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match not found: ' + matchId }) };

    if (type === 'result_pending') {
      await firebasePatch(`matches/${matchId}`, DB_URL, { status: 'result_pending' });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, statusUpdated: 'result_pending' }) };
    }

    // FIX 7: Removed emojis from title/body — some Android versions/OEMs
    // silently drop notifications with emoji in the title string.
    let title, body;
    if (type === 'room_details') {
      title = `Room Ready - Match #${matchId}`;
      body  = `Room ID: ${match.roomId || '-'}   Password: ${match.roomPassword || '-'}`;
    } else if (type === 'match_started') {
      title = `Match #${matchId} is LIVE!`;
      body  = `${match.title || 'Your match'} has started. Join the room now!`;
    } else if (type === 'match_cancelled') {
      title = `Match #${matchId} Cancelled`;
      body  = reason ? `Reason: ${reason}` : 'The match has been cancelled.';
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type: ' + type }) };
    }

    const userIds = collectUserIds(match);
    if (userIds.length === 0)
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No players joined yet.' }) };

    // FIX 8: Use Promise.allSettled for token fetch to avoid race conditions
    // from concurrent async pushes into the shared fcmTokens array.
    const tokenResults = await Promise.allSettled(
      userIds.map(async (uid) => {
        const user = await firebaseGet(`users/${uid}`, DB_URL);
        if (user && user.fcmToken && user.status !== 'banned') return user.fcmToken;
        return null;
      })
    );

    const fcmTokens = tokenResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (fcmTokens.length === 0)
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No FCM tokens found.' }) };

    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client      = await auth.getClient();
    const tokenData   = await client.getAccessToken();
    const accessToken = tokenData.token;
    const projectId   = SERVICE_ACCOUNT.project_id;

    const notifData = { matchId: String(matchId), type };
    const results = await Promise.allSettled(
      fcmTokens.map(token => sendOne(accessToken, projectId, token, title, body, notifData))
    );

    const sent   = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const failed = results.length - sent;

    console.log(`[notify] matchId=${matchId} type=${type} users=${userIds.length} tokens=${fcmTokens.length} sent=${sent} failed=${failed}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, sent, failed, total: fcmTokens.length, userIds: userIds.length })
    };

  } catch (err) {
    console.error('notify error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
