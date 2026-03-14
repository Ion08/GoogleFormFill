const state = {
  authenticated: false,
  session: null,
  credits: 0,
  sdkReady: false
};

const ui = {
  authView: document.getElementById("authView"),
  appView: document.getElementById("appView"),
  email: document.getElementById("email"),
  credits: document.getElementById("credits"),
  status: document.getElementById("status"),
  loginBtn: document.getElementById("loginBtn"),
  solveBtn: document.getElementById("solveBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  logoutBtn: document.getElementById("logoutBtn")
};

function setStatus(message, tone = "info") {
  ui.status.textContent = message || "";
  ui.status.className = `status ${tone}`;
}

function render() {
  if (!state.authenticated) {
    ui.authView.classList.remove("hidden");
    ui.appView.classList.add("hidden");
    return;
  }

  ui.authView.classList.add("hidden");
  ui.appView.classList.remove("hidden");

  ui.email.textContent = state.session?.email || "Unknown";
  ui.credits.textContent = String(state.credits ?? 0);
}

function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

async function bootstrapSdkSession(session) {
  try {
    const { af_config: config } = await chrome.storage.local.get("af_config");
    if (!window.Appwrite || !config?.appwriteEndpoint || !config?.appwriteProjectId || !session?.secret) {
      return;
    }

    const client = new window.Appwrite.Client()
      .setEndpoint(config.appwriteEndpoint)
      .setProject(config.appwriteProjectId)
      .setSession(session.secret);

    const account = new window.Appwrite.Account(client);
    await account.get();
    state.sdkReady = true;
  } catch (_err) {
    state.sdkReady = false;
  }
}

function mapErrorToMessage(code) {
  const normalized = String(code || "").toLowerCase();
  if (normalized.includes("not authorized") || normalized.includes("invalid origin")) {
    return "Appwrite rejected this request. Check Function execute permissions and users table read permissions for this user.";
  }

  if (normalized.includes("receiving end does not exist") || normalized.includes("could not establish connection")) {
    return "Form helper was not attached yet. Reload the Google Form tab and try Solve again.";
  }

  if (normalized === "form_parse_error:edit_mode_url") {
    return "You opened the form editor URL. Open the public form link ending in /viewform and try again.";
  }

  if (normalized === "form_parse_error:no_entry_fields_found") {
    return "No fillable form fields were detected. Open the actual question page (not confirmation/preview) and try again.";
  }

  if (normalized === "form_parse_error:no_supported_questions") {
    return "Questions were found but not in a supported format yet. Try reloading the form page and then Solve again.";
  }

  if (normalized === "ai_error:openrouter_api_key_missing") {
    return "OpenRouter key is missing in Appwrite Function environment variables.";
  }

  if (normalized.startsWith("ai_error:openrouter_http_401") || normalized.startsWith("ai_error:openrouter_http_403")) {
    return "OpenRouter rejected the request. Verify PLATFORM_OPENROUTER_KEY in Appwrite Function settings.";
  }

  if (normalized === "ai_error:appwrite_permission_denied") {
    return "Appwrite denied backend access. Check APPWRITE_API_KEY scopes for TablesDB read/write and Users read.";
  }

  if (normalized === "ai_error:appwrite_resource_not_found") {
    return "Appwrite database/table IDs are incorrect. Verify APPWRITE_DATABASE_ID and table IDs in Function env vars.";
  }

  if (normalized === "ai_error:no_details_from_function") {
    return "Backend returned a generic AI error. Redeploy solveForm from latest code, then verify PLATFORM_OPENROUTER_KEY and APPWRITE_API_KEY scopes in Appwrite Function settings.";
  }

  const messages = {
    AUTH_REQUIRED: "Please sign in first.",
    AUTH_PAGE_LOAD_FAILED: "Google sign-in page could not load. Check Appwrite OAuth provider and redirect domain settings.",
    FORM_PARSE_ERROR: "Could not parse this Google Form.",
    NO_CREDITS: "No credits left. Please top up your account.",
    RATE_LIMITED: "Rate limit reached. Try again later.",
    AI_ERROR: "AI service is temporarily unavailable.",
    NOT_ON_GOOGLE_FORM: "Open a Google Form tab first.",
    SOLVE_IN_PROGRESS: "A solve request is already in progress."
  };

  return messages[code] || `Unexpected error: ${code}`;
}

async function loadSession() {
  setStatus("Loading session...");

  const response = await sendMessage("GET_SESSION");

  if (!response?.ok || !response.authenticated) {
    state.authenticated = false;
    state.session = null;
    state.credits = 0;
    setStatus("Not signed in.", "info");
    render();
    return;
  }

  state.authenticated = true;
  state.session = response.session;
  state.credits = Number(response.credits || 0);

  await bootstrapSdkSession(response.session);

  setStatus(state.sdkReady ? "Signed in and SDK session active." : "Signed in.", "success");
  render();
}

async function login() {
  setStatus("Opening Google sign-in...");
  ui.loginBtn.disabled = true;

  try {
    const response = await sendMessage("AUTH_LOGIN");
    if (!response?.ok) {
      throw new Error(response?.error || "AUTH_REQUIRED");
    }

    state.authenticated = true;
    state.session = response.session;
    state.credits = Number(response.credits || 0);

    await bootstrapSdkSession(response.session);

    setStatus("Login successful.", "success");
    render();
  } catch (err) {
    setStatus(mapErrorToMessage(err.message), "error");
  } finally {
    ui.loginBtn.disabled = false;
  }
}

async function logout() {
  await sendMessage("AUTH_LOGOUT");
  state.authenticated = false;
  state.session = null;
  state.credits = 0;
  state.sdkReady = false;
  setStatus("Logged out.", "info");
  render();
}

async function refreshCredits() {
  setStatus("Refreshing credits...");

  const response = await sendMessage("REFRESH_CREDITS");
  if (!response?.ok) {
    setStatus(mapErrorToMessage(response?.error || "AI_ERROR"), "error");
    return;
  }

  state.credits = Number(response.credits || 0);
  render();
  setStatus("Credits updated.", "success");
}

async function solveForm() {
  ui.solveBtn.disabled = true;
  setStatus("Extracting and solving form...");

  try {
    const response = await sendMessage("SOLVE_FORM");
    if (!response?.ok) {
      const detailCode = response?.details?.code;
      throw new Error(detailCode ? `${response?.error || "AI_ERROR"}:${detailCode}` : (response?.error || "AI_ERROR"));
    }

    if (typeof response.creditsLeft === "number") {
      state.credits = response.creditsLeft;
    }

    render();
    setStatus(`Solved and filled ${response.filled || 0} question(s).`, "success");
  } catch (err) {
    setStatus(mapErrorToMessage(err.message), "error");
  } finally {
    ui.solveBtn.disabled = false;
  }
}

ui.loginBtn.addEventListener("click", login);
ui.logoutBtn.addEventListener("click", logout);
ui.refreshBtn.addEventListener("click", refreshCredits);
ui.solveBtn.addEventListener("click", solveForm);

loadSession().catch((err) => {
  setStatus(mapErrorToMessage(err.message || "AI_ERROR"), "error");
});
