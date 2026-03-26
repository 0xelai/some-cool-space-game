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
const SESSION_KEY = "spacejumper-sphere-session";

const state = {
  isConnected: false,
  isConnecting: false,
  isDepositPaid: false,
  identity: null,
  balance: null,
  error: null,
};

let client = null;
let transport = null;
let popupWindow = null;
let uctCoinId = null;
let uctDecimals = UCT_DECIMALS;

function isInIframe() {
  try { return window.self !== window.top; } catch { return true; }
}

function u() {
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

function destroyTransport() {
  try { transport?.destroy?.(); } catch {}
  transport = null;
}

function resetState() {
  destroyTransport();
  client = null;
  state.isConnected = false;
  state.isConnecting = false;
  state.isDepositPaid = false;
  state.identity = null;
  state.balance = null;
  state.error = null;
  try { popupWindow?.close?.(); } catch {}
  popupWindow = null;
  sessionStorage.removeItem(SESSION_KEY);
}

// ── Wait for popup HOST_READY ──────────────────────────────────────────────
function waitForHostReady(ms = HOST_READY_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      window.removeEventListener("message", h);
      reject(new Error("Wallet did not respond. Please try again."));
    }, ms);
    function h(e) {
      if (e.data?.type === HOST_READY_TYPE) {
        clearTimeout(t);
        window.removeEventListener("message", h);
        resolve();
      }
    }
    window.addEventListener("message", h);
  });
}

// ── After successful connect ───────────────────────────────────────────────
async function onConnected(result) {
  state.isConnected = true;
  state.isConnecting = false;
  state.identity = result.identity;
  state.error = null;
  if (result.sessionId) sessionStorage.setItem(SESSION_KEY, result.sessionId);

  if (!state.identity?.nametag) {
    state.error = "No Unicity ID found. Register one in Sphere to play.";
    updateUI("connected");
    return;
  }

  await refreshBalance();
  updateUI("connected");
}

// ── Connect ────────────────────────────────────────────────────────────────
async function connect() {
  if (state.isConnecting) return;
  state.isConnecting = true;
  state.error = null;
  updateUI("connecting");

  try {
    // Try iframe first
    if (isInIframe()) {
      destroyTransport();
      transport = PostMessageTransport.forClient();
      client = new ConnectClient({ transport, dapp: { name: "Space Jumper", description: "Pay 10 UCT to play", url: location.origin } });
      const result = await client.connect();
      await onConnected(result);
      return;
    }

    // Try extension (with short timeout so it doesn't hang)
    try {
      destroyTransport();
      transport = ExtensionTransport.forClient();
      client = new ConnectClient({ transport, dapp: { name: "Space Jumper", description: "Pay 10 UCT to play", url: location.origin } });
      const result = await Promise.race([
        client.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("no extension")), 2000))
      ]);
      await onConnected(result);
      return;
    } catch {
      destroyTransport();
      client = null;
    }

    // Popup mode
    if (!popupWindow || popupWindow.closed) {
      popupWindow = window.open(
        WALLET_URL + "/connect?origin=" + encodeURIComponent(location.origin),
        "sphere-wallet",
        "width=420,height=650,left=200,top=80"
      );
      if (!popupWindow) {
        throw new Error("Popup blocked. Please allow popups for this site and try again.");
      }
    } else {
      popupWindow.focus();
    }

    destroyTransport();
    transport = PostMessageTransport.forClient({ target: popupWindow, targetOrigin: WALLET_URL });

    await waitForHostReady();

    const resume = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    client = new ConnectClient({
      transport,
      dapp: { name: "Space Jumper", description: "Pay 10 UCT to play", url: location.origin },
      resumeSessionId: resume,
    });

    const result = await client.connect();
    await onConnected(result);

  } catch (err) {
    state.isConnecting = false;
    state.isConnected = false;
    state.error = err?.message || "Connection failed";
    updateUI("disconnected");
  }
}

async function disconnect() {
  try { await client?.disconnect?.(); } catch {}
  resetState();
  updateUI("disconnected");
}

async function refreshBalance() {
  if (!client) return;
  try {
    const assets = await client.query("sphere_getBalance");
    if (Array.isArray(assets)) {
      const uct = assets.find(a => a.symbol === COIN_ID);
      if (uct) {
        uctCoinId = uct.coinId;
        uctDecimals = uct.decimals || UCT_DECIMALS;
        state.balance = Number(uct.totalAmount) / Math.pow(10, uctDecimals);
      } else {
        uctCoinId = UCT_COIN_ID_HEX;
        state.balance = 0;
      }
    }
  } catch (e) { console.error("Balance fetch failed:", e); }
}

// ── DEPOSIT — NO RELOAD, just set ready ───────────────────────────────────
async function deposit() {
  if (!state.isConnected) {
    state.error = "Not connected";
    updateUI("disconnected");
    return false;
  }
  if (!state.identity?.nametag) {
    state.error = "Unicity ID required. Register one in Sphere.";
    updateUI("connected");
    return false;
  }
  if (state.balance !== null && state.balance < ENTRY_FEE) {
    state.error = `Not enough balance. Need at least ${ENTRY_FEE} ${COIN_ID}.`;
    updateUI("connected");
    return false;
  }

  try {
    updateUI("depositing");

    await client.intent("send", {
      to:     GAME_WALLET_ADDRESS,
      amount: ENTRY_FEE,
      coinId: uctCoinId || UCT_COIN_ID_HEX,
      memo:   "Space Jumper entry fee",
    });

    // ✅ NO RELOAD — just mark paid and start game directly
    state.isDepositPaid = true;
    state.error = null;
    await refreshBalance();
    updateUI("ready");  // this triggers _onWalletReady → startGame()
    return true;

  } catch (err) {
    state.error = err?.message || "Payment failed. Please try again.";
    updateUI("connected");
    return false;
  }
}

async function depositAndRestart() {
  await deposit();
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
          disconnectBtn, errorDiv, menuScreen, gameScreen } = u();

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
      if (depositBtn) {
        depositBtn.style.display = "block";
        depositBtn.innerHTML     = "CONFIRMING…";
        depositBtn.disabled      = true;
      }
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
window.addEventListener("load", () => {
  document.getElementById("sphere-connect-btn")?.addEventListener("click", connect);
  document.getElementById("sphere-deposit-btn")?.addEventListener("click", depositAndRestart);
  document.getElementById("sphere-disconnect-btn")?.addEventListener("click", disconnect);

  // Watch for popup being closed while connected
  setInterval(() => {
    if (state.isConnected && popupWindow && popupWindow.closed) {
      resetState();
      updateUI("disconnected");
    }
  }, 1000);

  updateUI("disconnected");
});

// ── Global API ────────────────────────────────────────────────────────────
window.SphereWallet = {
  get isConnected()   { return state.isConnected; },
  get isDepositPaid() { return state.isDepositPaid; },
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
  resetDeposit() { state.isDepositPaid = false; },
};
