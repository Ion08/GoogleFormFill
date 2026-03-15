importScripts("appwrite-web-sdk.js");

const DEFAULT_CONFIG = {
  appwriteEndpoint: "https://fra.cloud.appwrite.io/v1",
  appwriteProjectId: "69b5015800281183d258",
  appwriteFunctionSolveId: "69b50ac000155a09f932",
  appwriteDatabaseId: "69b502620001c600ec4b",
  appwriteUsersTableId: "users"
};

const STORAGE_KEYS = {
  config: "af_config",
  session: "af_session",
  inFlightSolve: "af_in_flight_solve"
};

function isPlaceholder(value) {
  return typeof value === "string" && value.startsWith("YOUR_");
}

async function getConfig() {
  const { [STORAGE_KEYS.config]: saved } = await chrome.storage.local.get(STORAGE_KEYS.config);
  const merged = { ...DEFAULT_CONFIG, ...(saved || {}) };

  // Keep old storage from pinning placeholders forever.
  if (isPlaceholder(merged.appwriteFunctionSolveId)) {
    merged.appwriteFunctionSolveId = DEFAULT_CONFIG.appwriteFunctionSolveId;
  }

  if (isPlaceholder(merged.appwriteDatabaseId)) {
    merged.appwriteDatabaseId = DEFAULT_CONFIG.appwriteDatabaseId;
  }

  if (!merged.appwriteUsersTableId && merged.appwriteUsersCollectionId) {
    merged.appwriteUsersTableId = merged.appwriteUsersCollectionId;
  }

  return merged;
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
  const params = new URLSearchParams({
    project: config.appwriteProjectId,
    success: successRedirect,
    failure: failureRedirect
  });

  return `${config.appwriteEndpoint}/account/tokens/oauth2/google?${params.toString()}`;
}

function getOAuthCallbackParam(parsedUrl, key) {
  const searchValue = parsedUrl.searchParams.get(key);
  if (searchValue) {
    return searchValue;
  }

  const rawHash = (parsedUrl.hash || "").replace(/^#/, "");
  if (!rawHash) {
    return null;
  }

  const hashParams = new URLSearchParams(rawHash);
  return hashParams.get(key);
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
    let details = "";
    try {
      const body = await response.json();
      details = body?.message || body?.type || "";
    } catch {
      // ignore
    }

    throw new Error(`Session token exchange failed: ${response.status}${details ? `:${details}` : ""}`);
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

function emitSolveProgress(percent, text, extra = {}) {
  chrome.runtime.sendMessage({
    action: "SOLVE_PROGRESS_EVENT",
    percent,
    text,
    ...extra
  }).catch(() => {
    // Popup may be closed; ignore progress delivery errors.
  });
}

function humanizeReportReason(code) {
  const labels = {
    answered: "Answered",
    requires_personal_data: "Requires personal data",
    unsupported_question_type: "Unsupported question type",
    unclear_image: "Unclear image",
    low_ai_confidence: "Low AI confidence",
    insufficient_context: "Insufficient context",
    invalid_answer_shape: "Invalid answer shape",
    answer_not_returned: "No answer returned",
    field_not_found: "Form field not found",
    option_not_found: "Matching option not found",
    fill_failed: "Could not fill answer"
  };

  return labels[code] || code || "Unknown";
}

function mergeSolveAndFillResults(solveResults, fillResults) {
  const fillById = new Map((fillResults || []).map((item) => [String(item.id), item]));

  const results = (solveResults || []).map((item) => {
    const fill = fillById.get(String(item.id));

    if (!fill || item.status !== "answered") {
      return {
        ...item,
        fillStatus: item.status === "answered" ? "not_attempted" : "skipped"
      };
    }

    if (fill.status === "filled") {
      return {
        ...item,
        fillStatus: "filled"
      };
    }

    const reason = fill.reason || "fill_failed";
    return {
      ...item,
      status: "skipped",
      skipReason: reason,
      reasonLabel: humanizeReportReason(reason),
      explanation: item.explanation
        ? `${item.explanation} The extension could not place this answer into the form: ${humanizeReportReason(reason)}.`
        : `The extension could not place this answer into the form: ${humanizeReportReason(reason)}.`,
      fillStatus: "skipped"
    };
  });

  return {
    results,
    summary: {
      total: results.length,
      answered: results.filter((item) => item.status === "answered").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      filled: results.filter((item) => item.fillStatus === "filled").length
    }
  };
}

async function getActiveFormTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];

  if (!tab?.id || !tab.url || !tab.url.includes("docs.google.com/forms")) {
    throw new Error("NOT_ON_GOOGLE_FORM");
  }

  return tab;
}

async function sendMessageToFormTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    const receiverMissing = msg.includes("receiving end does not exist") || msg.includes("could not establish connection");

    if (!receiverMissing) {
      throw err;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
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
  const redirectUrl = chrome.identity.getRedirectURL();
  const oauthUrl = buildOAuthUrlWithSdk(config, redirectUrl, redirectUrl);

  let callbackUrl;
  try {
    callbackUrl = await chrome.identity.launchWebAuthFlow({
      url: oauthUrl,
      interactive: true
    });
  } catch (_err) {
    throw new Error("AUTH_PAGE_LOAD_FAILED");
  }

  if (!callbackUrl) {
    throw new Error("AUTH_PAGE_LOAD_FAILED");
  }

  const parsed = new URL(callbackUrl);
  const userId = getOAuthCallbackParam(parsed, "userId");
  const secret = getOAuthCallbackParam(parsed, "secret");
  const error = getOAuthCallbackParam(parsed, "error");

  if (error) {
    throw new Error(`AUTH_ERROR:${error}`);
  }

  if (!userId || !secret) {
    throw new Error("AUTH_ERROR:missing_user_or_secret");
  }

  let sessionSecret = secret;

  try {
    const exchanged = await exchangeOAuthToken(config, userId, secret);
    sessionSecret = exchanged?.secret || secret;
  } catch (err) {
    // Some Appwrite configurations deny /account/sessions/token for this flow.
    // Fall back to using the OAuth secret directly as session.
    if (!String(err.message || "").includes("403")) {
      throw err;
    }
  }

  const user = await getAccount(config, sessionSecret);

  const session = {
    userId,
    secret: sessionSecret,
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

    if (request?.action === "SOLVE_PROGRESS_UPDATE") {
      emitSolveProgress(request.percent, request.text, {
        phase: request.phase,
        processed: request.processed,
        total: request.total,
        done: request.done
      });
      sendResponse({ ok: true });
      return;
    }

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
        emitSolveProgress(3, "Checking session...");
        const session = await getSession();
        if (!session) {
          return { ok: false, error: "AUTH_REQUIRED" };
        }

        emitSolveProgress(10, "Extracting form questions...");
        const tab = await getActiveFormTab();
        const extraction = await sendMessageToFormTab(tab.id, { action: "EXTRACT_FORM" });

        if (!extraction?.ok || !extraction.form?.questions?.length) {
          const detailCode = extraction?.details?.code;
          return {
            ok: false,
            error: detailCode ? `FORM_PARSE_ERROR:${detailCode}` : "FORM_PARSE_ERROR"
          };
        }

        const jwt = await createJwt(config, session.secret);
        emitSolveProgress(35, "Sending questions to AI...");
        const payload = {
          userId: session.userId,
          jwt,
          questions: extraction.form.questions,
          formTitle: extraction.form.title || "Untitled Form"
        };

        const solve = await executeSolveFunction(config, session, payload);

        if (!solve?.ok) {
          const fallbackDetails =
            solve?.error === "AI_ERROR" && !solve?.details
              ? { code: "NO_DETAILS_FROM_FUNCTION" }
              : null;

          return {
            ok: false,
            error: solve?.error || "AI_ERROR",
            details: solve?.details || fallbackDetails
          };
        }

        emitSolveProgress(70, "Applying answers to the form...");
        const fillResult = await sendMessageToFormTab(tab.id, {
          action: "FILL_FORM",
          results: solve.results || []
        });

        if (!fillResult?.ok) {
          return { ok: false, error: "FORM_PARSE_ERROR" };
        }

        const report = mergeSolveAndFillResults(solve.results || [], fillResult.results || []);
        emitSolveProgress(100, "Solve completed.", { done: true });

        return {
          ok: true,
          filled: report.summary.filled,
          creditsLeft: solve.creditsLeft,
          report
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
