/**
 * Helper functions for FCM token management
 */

// Get FCM tokens from database for a user
async function getTokensFromDatabase(pool, userId, email = null) {
  try {
    const client = await pool.connect();
    try {
      let deviceTokens = [];

      // Try to get tokens by user ID first
      if (userId) {
        const tokenQuery = await client.query(
          `SELECT device_token, platform FROM device_tokens WHERE user_id = $1`,
          [userId]
        );

        if (tokenQuery.rows.length > 0) {
          deviceTokens = tokenQuery.rows;
        }
      }

      // If no tokens found by ID and we have email, try by email
      if (deviceTokens.length === 0 && email) {
        const tokenQuery = await client.query(
          `SELECT device_token, platform FROM device_tokens WHERE email = $1`,
          [email]
        );

        if (tokenQuery.rows.length > 0) {
          deviceTokens = tokenQuery.rows;
        }
      }

      console.log(
        `Found ${deviceTokens.length} device tokens for user ${userId || email}`
      );

      // Format tokens to match fcmTokenStore format
      return deviceTokens.map((row) => ({
        token: row.device_token,
        platform: row.platform,
        lastUpdated: Date.now(),
      }));
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error retrieving FCM tokens from database:", error);
    return [];
  }
}

module.exports = {
  getTokensFromDatabase,
};
