const { GoogleAuth } = require('google-auth-library');

// ── Firebase REST helpers ─────────────────────────────────────────────────────
async function firebaseGet(path, dbUrl) {
  const res = await fetch(`${dbUrl}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
  return res.json();
}

// ── FCM send (single token) ───────────────────────────────────────────────────
async function sendOne(accessToken, projectId, token, title, body, data = {}, channelId = 'high_importance_channel') {
  const fcmBody = {
    message: {
      token,
      notification: { title, body },
      data: {
        ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        title,
        body
      },
      android: {
        priority: 'HIGH',
        notification: {
          sound:                 'default',
          channel_id:            channelId,
          click_action:          'FLUTTER_NOTIFICATION_CLICK',
          notification_priority: 'PRIORITY_HIGH',
          visibility:            'PUBLIC'
        }
      }
    }
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fcmBody)
    }
  );

  const responseText = await res.text();
  let responseJson;
  try { responseJson = JSON.parse(responseText); } catch (_) { responseJson = null; }

  if (!res.ok || (responseJson && responseJson.error)) {
    console.error(`[FCM] FAILED token=...${token.slice(-8)} status=${res.status} body=${responseText}`);
    return { ok: false, status: res.status, response: responseJson || responseText };
  }

  console.log(`[FCM] OK token=...${token.slice(-8)} messageId=${responseJson?.name}`);
  return { ok: true, status: res.status, response: responseJson };
}

// ── Collect userIds from match data ───────────────────────────────────────────
function collectUserIds(match) {
  const ids = new Set();
  if (match.players && typeof match.players === 'object') {
    Object.values(match.players).forEach(p => { if (p && p.userId) ids.add(p.userId); });
  }
  if (match.teams && typeof match.teams === 'object') {
    Object.values(match.teams).forEach(team => {
      if (!team) return;
      if (team.leaderId) ids.add(team.leaderId);
      if (team.members && typeof team.members === 'object') {
        Object.keys(team.members).forEach(uid => { if (!/^p\d+$/.test(uid)) ids.add(uid); });
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

    // ── Get OAuth access token ────────────────────────────────────────────────
    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client      = await auth.getClient();
    const tokenData   = await client.getAccessToken();
    const accessToken = tokenData.token;
    const projectId   = SERVICE_ACCOUNT.project_id;

    // ── Channel id (test panel can override to find the right one) ────────────
    const channelId = payload._testChannelId || 'high_importance_channel';

    // ── result_pending: no push needed ────────────────────────────────────────
    if (type === 'result_pending') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, statusUpdated: 'result_pending' }) };
    }

    // ── Build notification text ───────────────────────────────────────────────
    const matchTitle    = payload.matchTitle    || '';
    const roomId        = payload.roomId        || '';
    const roomPassword  = payload.roomPassword  || '';

    let title, body;
    if (type === 'room_details') {
      title = `Room Ready - Match #${matchId}`;
      body  = `Room ID: ${roomId || '-'}  Password: ${roomPassword || '-'}`;
    } else if (type === 'match_started') {
      title = `Match #${matchId} is LIVE!`;
      body  = `${matchTitle || 'Your match'} has started. Join the room now!`;
    } else if (type === 'match_cancelled') {
      title = `Match #${matchId} Cancelled`;
      body  = reason ? `Reason: ${reason}` : 'The match has been cancelled.';
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type: ' + type }) };
    }

    // ── Collect FCM tokens ────────────────────────────────────────────────────
    let fcmTokens = [];

    // Test mode: use the injected token directly, skip all Firebase reads
    if (payload._testToken) {
      console.log(`[notify] TEST MODE — using injected token`);
      fcmTokens = [payload._testToken];
    } else {
      // Production: get userIds from inline payload data (avoids race with match deletion)
      // or fall back to fetching match from Firebase (hoster page path)
      let match;
      const hasInlineData = payload.players !== undefined || payload.teams !== undefined;

      if (hasInlineData) {
        match = { players: payload.players || null, teams: payload.teams || null };
        console.log(`[notify] Using inline match data matchId=${matchId}`);
      } else {
        match = await firebaseGet(`matches/${matchId}`, DB_URL);
        if (!match)
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match not found: ' + matchId }) };
        console.log(`[notify] Fetched match from Firebase matchId=${matchId}`);
      }

      const userIds = collectUserIds(match);
      console.log(`[notify] userIds found: ${userIds.length} → ${JSON.stringify(userIds)}`);

      if (userIds.length === 0)
        return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No players found in match data.' }) };

      // Fetch FCM tokens from /users — safe even after match deletion
      const tokenResults = await Promise.allSettled(
        userIds.map(async (uid) => {
          const user = await firebaseGet(`users/${uid}`, DB_URL);
          console.log(`[notify] uid=${uid} fcmToken=${user?.fcmToken ? 'found' : 'MISSING'} status=${user?.status}`);
          if (user && user.fcmToken && user.status !== 'banned') return user.fcmToken;
          return null;
        })
      );

      fcmTokens = tokenResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
    }

    console.log(`[notify] fcmTokens to send: ${fcmTokens.length}`);

    if (fcmTokens.length === 0)
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No FCM tokens found.' }) };

    // ── Send to all ───────────────────────────────────────────────────────────
    const notifData = { matchId: String(matchId), type };
    const results = await Promise.allSettled(
      fcmTokens.map(token => sendOne(accessToken, projectId, token, title, body, notifData, channelId))
    );

    const sent        = results.filter(r => r.status === 'fulfilled' && r.value?.ok === true).length;
    const failed      = results.length - sent;
    const fcmResponse = results[0]?.value?.response || null;

    console.log(`[notify] matchId=${matchId} type=${type} tokens=${fcmTokens.length} sent=${sent} failed=${failed}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, sent, failed, total: fcmTokens.length, fcmResponse })
    };

  } catch (err) {
    console.error('notify error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
