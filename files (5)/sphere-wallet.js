import {
  ConnectClient,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
} from "https://esm.sh/@unicitylabs/sphere-sdk/connect";

import {
  PostMessageTransport,
  ExtensionTransport,
} from "https://esm.sh/@unicitylabs/sphere-sdk/connect/browser";

const WALLET_URL = "https://sphere.unicity.network";
const GAME_WALLET_ADDRESS = "@elaiii";
const ENTRY_FEE = 10;
const COIN_ID = "UCT";
const UCT_COIN_ID_HEX = "455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89";
const UCT_DECIMALS = 18;
const FAUCET_URL = "https://faucet.unicity.network/api/v1/faucet/request";
const SESSION_KEY_POPUP = "sphere-connect-popup-session";
const DEPOSIT_KEY = "spacejumper-deposit-paid";

const state = {
  isConnected: false,
  isConnecting: false,
  isDepositPaid: false,   // ← FIXED: was missing
  isWalletLocked: false,
  identity: null,
  permissions: [],
  balance: null,
  error: null,
};

let client = null;
let transport = null;
let popupWindow = null;
let popupMode = false;
let uctCoinId = null;
let uctDecimals = UCT_DECIMALS;

function isInIframe() {
  try { return window.self !== window.top; } catch { return true; }
}

function ui() {
  return {
    connectBtn:    document.getElementById("sphere-connect-btn"),
    walletInfo:    document.getElementById("sphere-wallet-info"),
    depositBtn:    document.getElementById("sphere-deposit-btn"),
    walletBalance: document.getElementById("sphere-balance"),
    walletAddress: document.getElementById("sphere-address"),
    disconnectBtn: document.getElementById("sphere-disconnect-btn"),
    errorDiv:      document.getElementById("sphere-error"),
    menuScreen:    document.getElementById("menu-screen"),
    gameScreen:    document.getElementById("game-screen"),
  };
}

function clearError() { state.error = null; }

function waitForHostReady(timeoutMs = HOST_READY_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Wallet popup did not become ready in time"));
    }, timeoutMs);
    function handler(event) {
      if (event.data?.type === HOST_READY_TYPE) {
        clearTimeout(timeout);
        window.removeEventListener("message", handler);
        resolve();
      }
    }
    window.addEventListener("message", handler);
  });
}

function destroyTransport() {
  try { transport?.destroy?.(); } catch {}
  transport = null;
}

function fullyDisconnectLocal() {
  destroyTransport();
  client = null;
  state.isConnected = false;
  state.isConnecting = false;
  state.isDepositPaid = false;
  state.isWalletLocked = false;
  state.identity = null;
  state.permissions = [];
  state.balance = null;
  state.error = null;
  popupMode = false;
  try { popupWindow?.close?.(); } catch {}
  popupWindow = null;
  sessionStorage.removeItem(SESSION_KEY_POPUP);
  sessionStorage.removeItem(DEPOSIT_KEY);
  updateUI("disconnected");
}

async function ensureClient() {
  if (client && !popupMode) return client;
  if (client && popupMode && popupWindow && !popupWindow.closed) return client;
  if (popupMode && (!popupWindow || popupWindow.closed)) {
    fullyDisconnectLocal();
    throw new Error("Wallet popup was closed");
  }
  throw new Error("Not connected");
}

// ── Connect helpers ────────────────────────────────────────────────────────
async function connectInsideIframe() {
  popupMode = false; destroyTransport();
  transport = PostMessageTransport.forClient();
  client = new ConnectClient({ transport, dapp: { name:"Space Jumper", description:"Pay 10 UCT to play", url: location.origin } });
  const result = await client.connect();
  state.isConnected = true; state.isConnecting = false;
  state.identity = result.identity; state.permissions = result.permissions || [];
  state.error = null;
  await refreshBalance();
  handlePostConnect();
}

async function connectViaExtension() {
  popupMode = false; destroyTransport();
  transport = ExtensionTransport.forClient();
  client = new ConnectClient({ transport, dapp: { name:"Space Jumper", description:"Pay 10 UCT to play", url: location.origin } });
  const result = await client.connect();
  state.isConnected = true; state.isConnecting = false;
  state.identity = result.identity; state.permissions = result.permissions || [];
  state.error = null;
  await refreshBalance();
  handlePostConnect();
}

async function connectViaPopup() {
  popupMode = true;
  if (!popupWindow || popupWindow.closed) {
    popupWindow = window.open(
      WALLET_URL + "/connect?origin=" + encodeURIComponent(location.origin),
      "sphere-wallet", "width=420,height=650"
    );
    if (!popupWindow) throw new Error("Popup blocked. Please allow popups for this site.");
  } else {
    popupWindow.focus();
  }
  destroyTransport();
  transport = PostMessageTransport.forClient({ target: popupWindow, targetOrigin: WALLET_URL });
  await waitForHostReady();
  const resumeSessionId = sessionStorage.getItem(SESSION_KEY_POPUP) ?? undefined;
  client = new ConnectClient({ transport, dapp: { name:"Space Jumper", description:"Pay 10 UCT to play", url: location.origin }, resumeSessionId });
  const result = await client.connect();
  if (result?.sessionId) sessionStorage.setItem(SESSION_KEY_POPUP, result.sessionId);
  state.isConnected = true; state.isConnecting = false;
  state.identity = result.identity; state.permissions = result.permissions || [];
  state.error = null;
  await refreshBalance();
  handlePostConnect();
}

// After connect — check if deposit was already paid (e.g. after page reload)
function handlePostConnect() {
  if (sessionStorage.getItem(DEPOSIT_KEY)) {
    sessionStorage.removeItem(DEPOSIT_KEY);
    state.isDepositPaid = true;
    updateUI("ready");
  } else {
    updateUI("connected");
  }
}

async function connect() {
  state.isConnecting = true;
  clearError();
  updateUI("connecting");
  try {
    if (isInIframe()) { await connectInsideIframe(); return; }
    try { await connectViaExtension(); return; } catch {}
    await connectViaPopup();
  } catch (err) {
    state.isConnecting = false;
    state.isConnected = false;
    state.error = err?.message || "Connection failed";
    updateUI("disconnected");
  }
}

async function disconnect() {
  try { await client?.disconnect?.(); } catch {}
  fullyDisconnectLocal();
}

async function refreshBalance() {
  try {
    const c = await ensureClient();
    const assets = await c.query("sphere_getBalance");
    if (Array.isArray(assets)) {
      const uct = assets.find(a => a.symbol === COIN_ID);
      if (uct) {
        uctCoinId   = uct.coinId;
        uctDecimals = uct.decimals || UCT_DECIMALS;
        state.balance = Number(uct.totalAmount) / Math.pow(10, uctDecimals);
      } else {
        uctCoinId     = UCT_COIN_ID_HEX;
        state.balance = 0;
      }
    }
  } catch (err) { console.error("Balance fetch failed:", err); }
}

// ── DEPOSIT — fixed params to match Boxy-Run exactly ──────────────────────
async function deposit() {
  if (!state.isConnected) {
    state.error = "Not connected"; updateUI("disconnected"); return false;
  }
  if (!state.identity?.nametag) {
    state.error = "Unicity ID required. Register one in Sphere.";
    updateUI("connected"); return false;
  }
  if (state.balance !== null && state.balance < ENTRY_FEE) {
    state.error = `Not enough balance. Need at least ${ENTRY_FEE} ${COIN_ID}.`;
    updateUI("connected"); return false;
  }
  try {
    updateUI("depositing");
    const c = await ensureClient();

    // ← FIXED: use "to" not "recipient", add memo, use resolved coinId
    await c.intent("send", {
      to:     GAME_WALLET_ADDRESS,
      amount: ENTRY_FEE,
      coinId: uctCoinId || UCT_COIN_ID_HEX,
      memo:   "Space Jumper entry fee",
    });

    state.isDepositPaid = true;
    state.error = null;
    await refreshBalance();

    // persist so page reload after payment restores state
    sessionStorage.setItem(DEPOSIT_KEY, "true");

    // reload — same pattern as Boxy-Run (depositAndRestart)
    document.location.reload();
    return true;
  } catch (err) {
    state.error = err?.message || "Payment failed. Please try again.";
    updateUI("connected");
    return false;
  }
}

async function depositAndRestart() {
  await deposit(); // deposit() already reloads on success
}

async function requestPayout(coins) {
  if (coins <= 0 || !state.identity) return false;
  const unicityId = (state.identity.nametag || "").replace(/^@/, "");
  if (!unicityId) return false;
  try {
    const r = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unicityId, coin: "unicity", amount: coins }),
    });
    return r.ok;
  } catch { return false; }
}

// ── UI ─────────────────────────────────────────────────────────────────────
function updateUI(phase) {
  const { connectBtn, walletInfo, depositBtn, walletBalance, walletAddress,
          disconnectBtn, errorDiv, menuScreen, gameScreen } = ui();

  const hideConnect = ["connected","depositing","ready","playing","gameover"].includes(phase);
  if (connectBtn)    connectBtn.style.display    = hideConnect ? "none" : "block";
  if (walletInfo)    walletInfo.style.display    = "none";
  if (depositBtn)    depositBtn.style.display    = "none";
  if (disconnectBtn) disconnectBtn.style.display = "none";

  if (errorDiv) {
    errorDiv.style.display = state.error ? "block" : "none";
    errorDiv.textContent   = state.error || "";
  }

  if (state.isConnected) {
    if (walletAddress) walletAddress.textContent = state.identity?.nametag || "Connected";
    if (walletBalance) walletBalance.textContent =
      state.balance !== null ? `${state.balance} ${COIN_ID}` : "...";
  }

  switch (phase) {
    case "disconnected":
      if (connectBtn) { connectBtn.innerHTML = "CONNECT WALLET"; connectBtn.disabled = false; }
      break;
    case "connecting":
      if (connectBtn) { connectBtn.innerHTML = "CONNECTING…"; connectBtn.disabled = true; }
      break;
    case "connected":
      if (walletInfo)    walletInfo.style.display    = "block";
      if (disconnectBtn) disconnectBtn.style.display = "inline-block";
      if (state.identity?.nametag && depositBtn) {
        depositBtn.style.display = "block";
        depositBtn.innerHTML     = `PLAY <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled      = false;
      }
      break;
    case "depositing":
      if (walletInfo) walletInfo.style.display = "block";
      if (depositBtn) { depositBtn.style.display = "block"; depositBtn.innerHTML = "CONFIRMING…"; depositBtn.disabled = true; }
      break;
    case "ready":
      if (walletInfo)    walletInfo.style.display    = "block";
      if (disconnectBtn) disconnectBtn.style.display = "inline-block";
      if (menuScreen) menuScreen.style.display = "none";
      if (gameScreen) gameScreen.style.display = "flex";
      if (window._onWalletReady) window._onWalletReady();
      break;
    case "playing":
      if (walletInfo) walletInfo.style.display = "block";
      break;
    case "gameover":
      if (walletInfo) walletInfo.style.display = "block";
      if (depositBtn) {
        depositBtn.style.display = "block";
        depositBtn.innerHTML     = `PLAY AGAIN <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled      = false;
      }
      break;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
function startPopupCloseWatcher() {
  setInterval(() => {
    if (state.isConnected && popupMode && popupWindow && popupWindow.closed) {
      fullyDisconnectLocal();
    }
  }, 1000);
}

async function trySilentAutoConnect() {
  try {
    if (isInIframe()) {
      try {
        await waitForHostReady(5000);
        popupMode = false; destroyTransport();
        transport = PostMessageTransport.forClient();
        client = new ConnectClient({ transport, dapp: { name:"Space Jumper", description:"Pay 10 UCT to play", url: location.origin }, silent: true });
        const result = await client.connect();
        state.isConnected = true; state.identity = result.identity; state.permissions = result.permissions || [];
        await refreshBalance(); handlePostConnect(); return;
      } catch {}
    }

    // Try extension silently
    try {
      popupMode = false; destroyTransport();
      transport = ExtensionTransport.forClient();
      client = new ConnectClient({ transport, dapp: { name:"Space Jumper", description:"Pay 10 UCT to play", url: location.origin }, silent: true });
      const result = await client.connect();
      state.isConnected = true; state.identity = result.identity; state.permissions = result.permissions || [];
      await refreshBalance(); handlePostConnect(); return;
    } catch {}

    // Try popup with saved session
    const savedSession = sessionStorage.getItem(SESSION_KEY_POPUP);
    if (savedSession) {
      popupMode = true;
      popupWindow = window.open(
        WALLET_URL + "/connect?origin=" + encodeURIComponent(location.origin),
        "sphere-wallet", "width=420,height=650"
      );
      if (!popupWindow) throw new Error("Popup blocked");
      destroyTransport();
      transport = PostMessageTransport.forClient({ target: popupWindow, targetOrigin: WALLET_URL });
      await waitForHostReady(10000);
      client = new ConnectClient({ transport, dapp: { name:"Space Jumper", description:"Pay 10 UCT to play", url: location.origin }, resumeSessionId: savedSession, silent: true });
      const result = await client.connect();
      if (result?.sessionId) sessionStorage.setItem(SESSION_KEY_POPUP, result.sessionId);
      state.isConnected = true; state.identity = result.identity; state.permissions = result.permissions || [];
      await refreshBalance(); handlePostConnect(); return;
    }
  } catch {
    fullyDisconnectLocal();
  }
}

window.addEventListener("load", async () => {
  document.getElementById("sphere-connect-btn")?.addEventListener("click", connect);
  document.getElementById("sphere-deposit-btn")?.addEventListener("click", depositAndRestart);
  document.getElementById("sphere-disconnect-btn")?.addEventListener("click", disconnect);
  startPopupCloseWatcher();
  updateUI("disconnected");
  await trySilentAutoConnect();
});

// ── Global API ────────────────────────────────────────────────────────────
window.SphereWallet = {
  get isConnected()   { return state.isConnected; },
  get isDepositPaid() { return state.isDepositPaid; },  // ← FIXED: was missing
  get identity()      { return state.identity; },
  get balance()       { return state.balance; },
  get error()         { return state.error; },
  get entryFee()      { return ENTRY_FEE; },
  get coinId()        { return COIN_ID; },
  connect,
  disconnect,
  deposit,
  depositAndRestart,
  refreshBalance,
  updateUI,
  async query(method, params) {
    const c = await ensureClient();
    return c.query(method, params);
  },
  async intent(action, params) {
    const c = await ensureClient();
    return c.intent(action, params);
  },
  resetDeposit() {
    state.isDepositPaid = false;
    sessionStorage.removeItem(DEPOSIT_KEY);
  },
};
