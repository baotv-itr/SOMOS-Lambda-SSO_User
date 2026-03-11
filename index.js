"use strict";

const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const mysql = require("mysql2/promise");

let dbPool;
let cognitoClient;

exports.handler = async (event, context) => {
  if (isCognitoPostAuthEvent(event)) {
    await handleCognitoPostAuthentication(event, context);
    return event;
  }

  await handleDirectEvent(event, context);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Lambda is ready" }),
    headers: { "Content-Type": "application/json" },
  };
};

async function handleDirectEvent(_event, _context) {
  return {
    ok: true,
    message: "Use Cognito PostAuthentication trigger payload to execute provisioning",
  };
}

async function handleCognitoPostAuthentication(event, _context) {
  const sub = event?.request?.userAttributes?.sub;
  const email = normalizeString(event?.request?.userAttributes?.email);

  if (!sub || !email) {
    log("warn", "Missing required SSO attributes, skip provisioning", {
      hasSub: Boolean(sub),
      hasEmail: Boolean(email),
      triggerSource: event?.triggerSource,
    });
    return;
  }

  const username = normalizeString(
    event?.request?.userAttributes?.preferred_username || event?.userName || email
  );
  const displayName = normalizeDisplayName(
    event?.request?.userAttributes?.name ||
      `${event?.request?.userAttributes?.given_name || ""} ${event?.request?.userAttributes?.family_name || ""}`.trim() ||
      null
  );
  const phone = normalizePhone(event?.request?.userAttributes?.phone_number || null);
  const now = new Date();
  const groups = await getUserGroups(event?.userPoolId, event?.userName);
  const roles = mapGroupsToRoles(groups);

  const payload = {
    sub,
    email,
    username,
    displayName,
    phone,
    enabled: true,
    roles,
    userSearchName: normalizeSearchName(displayName),
    lastLoginAt: toMysqlDateTime(now),
    createdAt: toMysqlDateTime(now),
    updatedAt: toMysqlDateTime(now),
  };

  await upsertUser(payload);
}

async function upsertUser(payload) {
  let conn;

  try {
    conn = await getDbPool().getConnection();
    await conn.beginTransaction();

    const [byId] = await conn.query("SELECT id, email FROM users WHERE id = ? LIMIT 1", [payload.sub]);
    if (byId.length > 0) {
      await conn.query(
        "UPDATE users SET email = ?, name = ?, role = CAST(? AS JSON), phone = ?, enabled = ?, last_login_at = ?, username = ?, user_search_name = ?, updatedAt = ? WHERE id = ?",
        [
          payload.email,
          payload.displayName,
          JSON.stringify(payload.roles),
          payload.phone,
          payload.enabled,
          payload.lastLoginAt,
          payload.username,
          payload.userSearchName,
          payload.updatedAt,
          payload.sub,
        ]
      );
      await conn.commit();
      return;
    }

    const [byEmail] = await conn.query("SELECT id FROM users WHERE email = ? LIMIT 1", [payload.email]);
    if (byEmail.length > 0) {
      if (process.env.ALLOW_EMAIL_LINK === "true") {
        await conn.query(
          "UPDATE users SET name = ?, role = CAST(? AS JSON), phone = ?, enabled = ?, last_login_at = ?, user_search_name = ?, updatedAt = ? WHERE email = ?",
          [
            payload.displayName,
            JSON.stringify(payload.roles),
            payload.phone,
            payload.enabled,
            payload.lastLoginAt,
            payload.userSearchName,
            payload.updatedAt,
            payload.email,
          ]
        );
        await conn.commit();
        return;
      }

      const message = "Email already exists in users table with different id";
      log("error", message, { email: payload.email, sub: payload.sub });

      if (process.env.FAIL_ON_ERROR === "true") {
        throw new Error(message);
      }

      await conn.rollback();
      return;
    }

    await conn.query(
      "INSERT INTO users (id, email, name, role, phone, enabled, last_login_at, username, user_search_name, createdAt, updatedAt) VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?)",
      [
        payload.sub,
        payload.email,
        payload.displayName,
        JSON.stringify(payload.roles),
        payload.phone,
        payload.enabled,
        payload.lastLoginAt,
        payload.username,
        payload.userSearchName,
        payload.createdAt,
        payload.updatedAt,
      ]
    );

    await conn.commit();
  } catch (error) {
    if (conn) {
      await conn.rollback();
    }
    log("error", "Failed to provision SSO user", {
      error: error.message,
      stack: error.stack,
    });

    if (process.env.FAIL_ON_ERROR === "true") {
      throw error;
    }
  } finally {
    if (conn) {
      conn.release();
    }
  }
}

async function getUserGroups(userPoolId, username) {
  if (!userPoolId || !username) {
    return [];
  }

  try {
    const command = new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    });
    const response = await getCognitoClient().send(command);
    return (response.Groups || []).map(group => group.GroupName).filter(Boolean);
  } catch (error) {
    log("warn", "Cannot fetch Cognito groups, fallback USER role", {
      error: error.message,
      userPoolId,
      username,
    });
    return [];
  }
}

function mapGroupsToRoles(groups) {
  if (groups.some(group => ["ADMIN", "Admin", "admin"].includes(group))) {
    return ["ADMIN"];
  }

  return ["USER"];
}

function isCognitoPostAuthEvent(event) {
  return (
    event &&
    typeof event === "object" &&
    typeof event.triggerSource === "string" &&
    event.triggerSource.startsWith("PostAuthentication") &&
    event.request &&
    event.request.userAttributes
  );
}

function getDbPool() {
  if (!dbPool) {
    if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USERNAME || !process.env.DB_PASSWORD) {
      throw new Error("Missing DB connection env vars: DB_HOST, DB_NAME, DB_USERNAME, DB_PASSWORD");
    }

    dbPool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionLimit: Number(process.env.DB_POOL_MAX || 5),
      waitForConnections: true,
      queueLimit: 0,
    });
  }

  return dbPool;
}

function getCognitoClient() {
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityProviderClient({
      region: process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-2",
    });
  }

  return cognitoClient;
}

function normalizeString(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
}

function normalizeDisplayName(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  return value.trim();
}

function normalizePhone(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSearchName(value) {
  if (!value) {
    return null;
  }

  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]+/g, "")
    .replace(/[^a-zA-Z0-9 ]+/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 191);
}

function toMysqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function log(level, message, meta) {
  const entry = { level, message, meta };
  console.log(JSON.stringify(entry));
}
