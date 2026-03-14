importScripts("appwrite-web-sdk.js");

const DEFAULT_CONFIG = {
  appwriteEndpoint: "https://fra.cloud.appwrite.io/v1",
  appwriteProjectId: "69b5015800281183d258",
  appwriteFunctionSolveId: "YOUR_SOLVE_FORM_FUNCTION_ID",
  appwriteDatabaseId: "YOUR_DATABASE_ID",
  appwriteUsersTableId: "users"
};

const STORAGE_KEYS = {
  config: "af_config",
  session: "af_session",
  inFlightSolve: "af_in_flight_solve"
};

async function getConfig() {
  const { [STORAGE_KEYS.config]: saved } = await chrome.storage.local.get(STORAGE_KEYS.config);
  return { ...DEFAULT_CONFIG, ...(saved || {}) };
}

async function setSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: session });
}

async function getSession() {
  const { [STORAGE_KEYS.session]: session } = await chrome.storage.local.get(STORAGE_KEYS.session);
  return session || null;
}

async function clearSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.session);
}

function buildOAuthUrlWithSdk(config, successRedirect, failureRedirect) {
  const client = new self.Appwrite.Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId);

  const account = new self.Appwrite.Account(client);
  return account.createOAuth2Token("google", successRedirect, failureRedirect);
}

async function exchangeOAuthToken(config, userId, secret) {
  const response = await fetch(`${config.appwriteEndpoint}/account/sessions/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Appwrite-Project": config.appwriteProjectId
    },
    body: JSON.stringify({ userId, secret })
  });

  if (!response.ok) {
    throw new Error(`Session token exchange failed: ${response.status}`);
  }

  return response.json();
}

async function getAccount(config, sessionSecret) {
  const response = await fetch(`${config.appwriteEndpoint}/account`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Appwrite-Project": config.appwriteProjectId,
      "X-Appwrite-Session": sessionSecret
    }
  });

  if (!response.ok) {
    throw new Error(`Account fetch failed: ${response.status}`);
  }

  return response.json();
}

async function createJwt(config, sessionSecret) {
  const response = await fetch(`${config.appwriteEndpoint}/account/jwts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Appwrite-Project": config.appwriteProjectId,
      "X-Appwrite-Session": sessionSecret
    }
  });

  if (!response.ok) {
    throw new Error(`JWT creation failed: ${response.status}`);
  }

  const payload = await response.json();
  return payload.jwt;
}

async function getUserCredits(config, session) {
  const client = new self.Appwrite.Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId)
    .setSession(session.secret);

  const tablesDB = new self.Appwrite.TablesDB(client);
  const usersTableId = config.appwriteUsersTableId || config.appwriteUsersCollectionId || "users";

  const result = await tablesDB.listRows(config.appwriteDatabaseId, usersTableId, [
    self.Appwrite.Query.equal("userId", session.userId),
    self.Appwrite.Query.limit(1)
  ]);

  const userRow = result.rows?.[0];
  if (!userRow) {
    return { credits: 0 };
  }

  return { credits: Number(userRow.credits || 0) };
}

async function executeSolveFunction(config, session, payload) {
  const response = await fetch(
    `${config.appwriteEndpoint}/functions/${config.appwriteFunctionSolveId}/executions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Appwrite-Project": config.appwriteProjectId,
        "X-Appwrite-Session": session.secret
      },
      body: JSON.stringify({
        async: false,
        body: JSON.stringify(payload),
        path: "/solve",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Function execution failed: ${response.status}`);
  }

  const execution = await response.json();
  const responseBody = execution.responseBody ? JSON.parse(execution.responseBody) : null;
  return responseBody;
}

async function getActiveFormTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];

  if (!tab?.id || !tab.url || !tab.url.includes("docs.google.com/forms")) {
    throw new Error("NOT_ON_GOOGLE_FORM");
  }

  return tab;
}

async function withSolveLock(handler) {
  const state = await chrome.storage.local.get(STORAGE_KEYS.inFlightSolve);
  if (state[STORAGE_KEYS.inFlightSolve]) {
    throw new Error("SOLVE_IN_PROGRESS");
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.inFlightSolve]: true });

  try {
    return await handler();
  } finally {
    await chrome.storage.local.set({ [STORAGE_KEYS.inFlightSolve]: false });
  }
}

async function loginWithGoogle() {
  const config = await getConfig();
  const redirectUrl = chrome.identity.getRedirectURL("appwrite");
  const oauthUrl = buildOAuthUrlWithSdk(config, redirectUrl, redirectUrl);

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: oauthUrl,
    interactive: true
  });

  const parsed = new URL(callbackUrl);
  const userId = parsed.searchParams.get("userId");
  const secret = parsed.searchParams.get("secret");
  const error = parsed.searchParams.get("error");

  if (error) {
    throw new Error(`AUTH_ERROR:${error}`);
  }

  if (!userId || !secret) {
    throw new Error("AUTH_ERROR:missing_user_or_secret");
  }

  await exchangeOAuthToken(config, userId, secret);
  const user = await getAccount(config, secret);

  const session = {
    userId,
    secret,
    email: user.email || "",
    name: user.name || "",
    updatedAt: new Date().toISOString()
  };

  await setSession(session);

  const credits = await getUserCredits(config, session).catch(() => ({ credits: 0 }));
  return { session, credits: credits.credits };
}

async function refreshCredits() {
  const config = await getConfig();
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "AUTH_REQUIRED" };
  }

  const credits = await getUserCredits(config, session);
  return { ok: true, credits: credits.credits, email: session.email };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.config);
  if (!existing[STORAGE_KEYS.config]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: DEFAULT_CONFIG });
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    const config = await getConfig();

    if (request?.action === "AUTH_LOGIN") {
      const result = await loginWithGoogle();
      sendResponse({ ok: true, ...result });
      return;
    }

    if (request?.action === "AUTH_LOGOUT") {
      await clearSession();
      sendResponse({ ok: true });
      return;
    }

    if (request?.action === "GET_SESSION") {
      const session = await getSession();
      if (!session) {
        sendResponse({ ok: true, authenticated: false });
        return;
      }

      const credits = await getUserCredits(config, session).catch(() => ({ credits: 0 }));
      sendResponse({
        ok: true,
        authenticated: true,
        session,
        credits: credits.credits
      });
      return;
    }

    if (request?.action === "REFRESH_CREDITS") {
      const result = await refreshCredits();
      sendResponse(result);
      return;
    }

    if (request?.action === "SOLVE_FORM") {
      const result = await withSolveLock(async () => {
        const session = await getSession();
        if (!session) {
          return { ok: false, error: "AUTH_REQUIRED" };
        }

        const tab = await getActiveFormTab();
        const extraction = await chrome.tabs.sendMessage(tab.id, { action: "EXTRACT_FORM" });

        if (!extraction?.ok || !extraction.form?.questions?.length) {
          return { ok: false, error: "FORM_PARSE_ERROR" };
        }

        const jwt = await createJwt(config, session.secret);
        const payload = {
          userId: session.userId,
          jwt,
          questions: extraction.form.questions,
          formTitle: extraction.form.title || "Untitled Form"
        };

        const solve = await executeSolveFunction(config, session, payload);

        if (!solve?.ok) {
          return {
            ok: false,
            error: solve?.error || "AI_ERROR",
            details: solve?.details || null
          };
        }

        const fillResult = await chrome.tabs.sendMessage(tab.id, {
          action: "FILL_FORM",
          answers: solve.answers
        });

        if (!fillResult?.ok) {
          return { ok: false, error: "FORM_PARSE_ERROR" };
        }

        return {
          ok: true,
          filled: fillResult.filled,
          creditsLeft: solve.creditsLeft
        };
      });

      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: "UNKNOWN_ACTION" });
  })().catch((err) => {
    const normalized = typeof err?.message === "string" ? err.message : "UNEXPECTED_ERROR";
    sendResponse({ ok: false, error: normalized });
  });

  return true;
});
