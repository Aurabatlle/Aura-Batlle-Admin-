const { GoogleAuth } = require('google-auth-library');

// ── Firebase REST helpers ─────────────────────────────────────────────────────
async function firebaseGet(path, dbUrl) {
  const res = await fetch(`${dbUrl}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
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
          // Required: triggers system tray in ALL app states (foreground/background/killed)
          notification: { title, body },
          // Also in data so Flutter onBackgroundMessage can read when notification is null
          data: {
            ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
            title,
            body
          },
          android: {
            priority: 'HIGH',
            notification: {
              sound: 'default',
              channel_id: 'match_alerts',   // must match your Flutter app's channel id
              click_action: 'FLUTTER_NOTIFICATION_CLICK',
              notification_priority: 'PRIORITY_HIGH',
              visibility: 'PUBLIC'
            }
          }
        }
      })
    }
  );

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

// ── Collect userIds from match data (solo + team) ─────────────────────────────
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

    const payload = JSON.parse(event.body);
    const { matchId, type, reason } = payload;
    if (!matchId || !type)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'matchId and type are required.' }) };

    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const DB_URL          = process.env.FIREBASE_DB_URL;

    // ── Match data ────────────────────────────────────────────────────────────
    // Use inline data from payload if provided (avoids race condition where the
    // match is deleted before this function can fetch it — e.g. match_cancelled).
    // Fall back to Firebase fetch only if not provided.
    let match;
    const hasInlineData = payload.players !== undefined || payload.teams !== undefined;

    if (hasInlineData) {
      // Reconstruct match object from inlined payload fields
      match = {
        title:        payload.matchTitle    || '',
        roomId:       payload.roomId        || '',
        roomPassword: payload.roomPassword  || '',
        players:      payload.players       || null,
        teams:        payload.teams         || null,
      };
      console.log(`[notify] Using inline match data for matchId=${matchId}`);
    } else {
      // Legacy path: fetch from Firebase (hoster page doesn't inline data)
      match = await firebaseGet(`matches/${matchId}`, DB_URL);
      if (!match)
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match not found: ' + matchId }) };
      console.log(`[notify] Fetched match from Firebase for matchId=${matchId}`);
    }

    // ── result_pending: status-only, no push ──────────────────────────────────
    if (type === 'result_pending') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, statusUpdated: 'result_pending' }) };
    }

    // ── Build notification text ───────────────────────────────────────────────
    let title, body;
    if (type === 'room_details') {
      title = `Room Ready - Match #${matchId}`;
      body  = `Room ID: ${match.roomId || '-'}  Password: ${match.roomPassword || '-'}`;
    } else if (type === 'match_started') {
      title = `Match #${matchId} is LIVE!`;
      body  = `${match.title || 'Your match'} has started. Join the room now!`;
    } else if (type === 'match_cancelled') {
      title = `Match #${matchId} Cancelled`;
      body  = reason ? `Reason: ${reason}` : 'The match has been cancelled.';
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type: ' + type }) };
    }

    // ── Collect userIds ───────────────────────────────────────────────────────
    const userIds = collectUserIds(match);
    if (userIds.length === 0)
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No players found in match data.' }) };

    // ── Fetch FCM tokens from Firebase ────────────────────────────────────────
    // We still need to read /users/{uid}/fcmToken — this is always safe because
    // user records are never deleted when a match is cancelled.
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

    // ── Get FCM OAuth token ───────────────────────────────────────────────────
    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client      = await auth.getClient();
    const tokenData   = await client.getAccessToken();
    const accessToken = tokenData.token;
    const projectId   = SERVICE_ACCOUNT.project_id;

    // ── Send to all tokens ────────────────────────────────────────────────────
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
