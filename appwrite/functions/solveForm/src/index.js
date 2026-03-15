const sdk = require("node-appwrite");
// This is a sample function that demonstrates how to solve a Google Form using an AI model (like OpenAI's GPT) and manage user credits in Appwrite. It includes error handling and rate limiting.
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
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body;
  } catch {
    return null;
  }
}

function json(res, status, payload) {
  return res.json(payload, status, { "Content-Type": "application/json" });
}

function classifyFailure(err) {
  const message = String(err?.message || "");

  if (message.startsWith("OPENROUTER_")) {
    return { code: message.split(":")[0] };
  }

  if (message.includes("not authorized") || message.includes("missing scope") || message.includes("permission")) {
    return { code: "APPWRITE_PERMISSION_DENIED" };
  }

  if (message.includes("Document not found") || message.includes("Collection not found") || message.includes("Database not found")) {
    return { code: "APPWRITE_RESOURCE_NOT_FOUND" };
  }

  return { code: "UNKNOWN", details: message };
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
    databases: new sdk.Databases(client)
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

function ownerPermissions(userId) {
  return [
    sdk.Permission.read(sdk.Role.user(userId)),
    sdk.Permission.update(sdk.Role.user(userId)),
    sdk.Permission.delete(sdk.Role.user(userId))
  ];
}

async function getOrCreateUserRow(databases, userData) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const starterCredits = Number(getEnv("STARTER_CREDITS", "5"));

  const result = await databases.listDocuments(databaseId, usersTableId, [
    sdk.Query.equal("userId", userData.$id),
    sdk.Query.limit(1)
  ]);

  if (result.documents?.length) {
    return result.documents[0];
  }

  return databases.createDocument(
    databaseId,
    usersTableId,
    sdk.ID.unique(),
    {
      userId: userData.$id,
      email: userData.email || "",
      credits: starterCredits
    },
    ownerPermissions(userData.$id)
  );
}

async function updateCredits(databases, userRow, delta) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const nextCredits = Number(userRow.credits || 0) + delta;

  return databases.updateDocument(databaseId, usersTableId, userRow.$id, {
    credits: nextCredits
  });
}

async function createTransaction(databases, userId, amount, type) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  return databases.createDocument(
    databaseId,
    transactionsTableId,
    sdk.ID.unique(),
    {
      userId: String(userId),
      amount: String(amount),
      type: String(type)
    },
    ownerPermissions(userId)
  );
}

async function enforceRateLimit(databases, userId) {
  const enabled = String(getEnv("RATE_LIMIT_ENABLED", "false")).toLowerCase() === "true";
  if (!enabled) {
    return { limited: false, enforced: false };
  }

  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  const maxPerWindow = Number(getEnv("RATE_LIMIT_MAX", "20"));
  const windowHours = Number(getEnv("RATE_LIMIT_WINDOW_HOURS", "1"));
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const recent = await databases.listDocuments(databaseId, transactionsTableId, [
    sdk.Query.equal("userId", userId),
    sdk.Query.equal("type", "use"),
    sdk.Query.greaterThanEqual("$createdAt", windowStart),
    sdk.Query.limit(maxPerWindow)
  ]);

  return {
    limited: (recent.documents?.length || 0) >= maxPerWindow,
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
    let providerMessage = "";
    try {
      const errBody = await response.json();
      providerMessage = errBody?.error?.message || errBody?.message || "";
    } catch {
      // ignore parse issues
    }

    throw new Error(`OPENROUTER_HTTP_${response.status}${providerMessage ? `:${providerMessage}` : ""}`);
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

    const { databases } = createAdminClients();

    const rate = await enforceRateLimit(databases, userId);
    if (rate.limited) {
      return json(res, 429, { ok: false, error: ERROR_CODES.RATE_LIMITED });
    }

    const userRow = await getOrCreateUserRow(databases, authenticated);
    const currentCredits = Number(userRow.credits || 0);

    if (currentCredits < 1) {
      return json(res, 402, { ok: false, error: ERROR_CODES.NO_CREDITS });
    }

    const answers = await callOpenRouter(questions, formTitle);

    const updatedUser = await updateCredits(databases, userRow, -1);
    await createTransaction(databases, userId, 1, "use");

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
    return json(res, 500, {
      ok: false,
      error: ERROR_CODES.AI_ERROR,
      details: classifyFailure(err)
    });
  }
};