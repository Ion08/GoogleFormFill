const sdk = require("node-appwrite");

const ERROR_CODES = {
  NO_CREDITS: "NO_CREDITS",
  FORM_PARSE_ERROR: "FORM_PARSE_ERROR",
  AI_ERROR: "AI_ERROR",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED"
};

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function parseJsonBody(req) {
  try {
    return req.body ? JSON.parse(req.body) : {};
  } catch {
    return null;
  }
}

function json(res, status, payload) {
  return res.json(payload, status, { "Content-Type": "application/json" });
}

function createAdminClients() {
  const endpoint = getEnv("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
  const projectId = getEnv("APPWRITE_PROJECT_ID");
  const apiKey = getEnv("APPWRITE_API_KEY");

  const client = new sdk.Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);

  return {
    tablesDB: new sdk.TablesDB(client)
  };
}

function createJwtAccountClient(jwt) {
  const endpoint = getEnv("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
  const projectId = getEnv("APPWRITE_PROJECT_ID");

  const client = new sdk.Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setJWT(jwt);

  return new sdk.Account(client);
}

function getUsersTableId() {
  return getEnv("APPWRITE_USERS_TABLE_ID", getEnv("APPWRITE_USERS_COLLECTION_ID", "users"));
}

function getTransactionsTableId() {
  return getEnv("APPWRITE_TRANSACTIONS_TABLE_ID", getEnv("APPWRITE_TRANSACTIONS_COLLECTION_ID", "transactions"));
}

async function getOrCreateUserRow(tablesDB, userData) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const starterCredits = Number(getEnv("STARTER_CREDITS", "5"));

  const result = await tablesDB.listRows(databaseId, usersTableId, [
    sdk.Query.equal("userId", userData.$id),
    sdk.Query.limit(1)
  ]);

  if (result.rows?.length) {
    return result.rows[0];
  }

  return tablesDB.createRow(databaseId, usersTableId, sdk.ID.unique(), {
    userId: userData.$id,
    email: userData.email || "",
    credits: starterCredits,
    createdAt: new Date().toISOString()
  });
}

async function updateCredits(tablesDB, userRow, delta) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const nextCredits = Number(userRow.credits || 0) + delta;

  return tablesDB.updateRow(databaseId, usersTableId, userRow.$id, {
    credits: nextCredits
  });
}

async function createTransaction(tablesDB, userId, amount, type) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  return tablesDB.createRow(databaseId, transactionsTableId, sdk.ID.unique(), {
    userId,
    amount,
    type,
    timestamp: new Date().toISOString()
  });
}

async function enforceRateLimit(tablesDB, userId) {
  const enabled = String(getEnv("RATE_LIMIT_ENABLED", "false")).toLowerCase() === "true";
  if (!enabled) {
    return { limited: false, enforced: false };
  }

  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  const maxPerWindow = Number(getEnv("RATE_LIMIT_MAX", "20"));
  const windowHours = Number(getEnv("RATE_LIMIT_WINDOW_HOURS", "1"));
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const recent = await tablesDB.listRows(databaseId, transactionsTableId, [
    sdk.Query.equal("userId", userId),
    sdk.Query.equal("type", "use"),
    sdk.Query.greaterThanEqual("timestamp", windowStart),
    sdk.Query.limit(maxPerWindow)
  ]);

  return {
    limited: (recent.rows?.length || 0) >= maxPerWindow,
    enforced: true
  };
}

async function callOpenRouter(questions, formTitle) {
  const apiKey = getEnv("OPENROUTER_API_KEY") || getEnv("PLATFORM_OPENROUTER_KEY");
  const model = getEnv("OPENROUTER_MODEL", "openai/gpt-4o-mini");
  const referer = getEnv("OPENROUTER_REFERER", "");

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY_MISSING");
  }

  const prompt = [
    "You are an IT homework solving assistant.",
    "Answer the questions accurately and concisely.",
    "Return ONLY JSON.",
    "Keys must be the question id.",
    "For checkbox questions, values must be arrays.",
    "Do not add markdown or explanations.",
    "",
    `Form title: ${formTitle || "Untitled Form"}`,
    "Questions:",
    JSON.stringify(questions)
  ].join("\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(referer ? { "HTTP-Referer": referer } : {})
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return only valid JSON where keys are question ids." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`OPENROUTER_HTTP_${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OPENROUTER_EMPTY_CONTENT");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("OPENROUTER_INVALID_JSON");
  }
}

module.exports = async ({ req, res, log, error }) => {
  const data = parseJsonBody(req);
  if (!data) {
    return json(res, 400, { ok: false, error: ERROR_CODES.FORM_PARSE_ERROR });
  }

  const { userId, jwt, questions, formTitle } = data;

  if (!userId || !jwt) {
    return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    return json(res, 400, { ok: false, error: ERROR_CODES.FORM_PARSE_ERROR });
  }

  try {
    const account = createJwtAccountClient(jwt);
    const authenticated = await account.get();

    if (authenticated.$id !== userId) {
      return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
    }

    const { tablesDB } = createAdminClients();

    const rate = await enforceRateLimit(tablesDB, userId);
    if (rate.limited) {
      return json(res, 429, { ok: false, error: ERROR_CODES.RATE_LIMITED });
    }

    const userRow = await getOrCreateUserRow(tablesDB, authenticated);
    const currentCredits = Number(userRow.credits || 0);

    if (currentCredits < 1) {
      return json(res, 402, { ok: false, error: ERROR_CODES.NO_CREDITS });
    }

    const answers = await callOpenRouter(questions, formTitle);

    const updatedUser = await updateCredits(tablesDB, userRow, -1);
    await createTransaction(tablesDB, userId, 1, "use");

    return json(res, 200, {
      ok: true,
      answers,
      creditsLeft: Number(updatedUser.credits || 0),
      rateLimit: {
        enabled: rate.enforced
      }
    });
  } catch (err) {
    error(`solveForm failed: ${err.message}`);
    log(err.stack || "no-stack");
    return json(res, 500, { ok: false, error: ERROR_CODES.AI_ERROR });
  }
};