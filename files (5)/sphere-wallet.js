import {
  ConnectClient,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
  WALLET_EVENTS,
} from "https://esm.sh/@unicitylabs/sphere-sdk/connect";

import {
  PostMessageTransport,
  ExtensionTransport,
} from "https://esm.sh/@unicitylabs/sphere-sdk/connect/browser";

const WALLET_URL = "https://sphere.unicity.network";
const GAME_WALLET_ADDRESS = "@elaiii";
const ENTRY_FEE = 10;
const COIN_ID = "UCT";
const UCT_DECIMALS = 18;

const SESSION_KEY_POPUP = "sphere-connect-popup-session";
const DEPOSIT_KEY = "spacejumper-deposit-paid";

const state = {
  isConnected: false,
  isConnecting: false,
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

function isInIframe() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function ui() {
  return {
    connectBtn: document.getElementById("sphere-connect-btn"),
    walletInfo: document.getElementById("sphere-wallet-info"),
    depositBtn: document.getElementById("sphere-deposit-btn"),
    walletBalance: document.getElementById("sphere-balance"),
    walletAddress: document.getElementById("sphere-address"),
    disconnectBtn: document.getElementById("sphere-disconnect-btn"),
    errorDiv: document.getElementById("sphere-error"),
    menuScreen: document.getElementById("menu-screen"),
    gameScreen: document.getElementById("game-screen"),
  };
}

function setError(message) {
  state.error = message || null;
  updateUI(state.isConnected ? "connected" : "disconnected");
}

function clearError() {
  state.error = null;
}

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
  try {
    transport?.destroy?.();
  } catch {}
  transport = null;
}

function fullyDisconnectLocal() {
  destroyTransport();
  client = null;
  state.isConnected = false;
  state.isConnecting = false;
  state.isWalletLocked = false;
  state.identity = null;
  state.permissions = [];
  state.balance = null;
  state.error = null;
  popupMode = false;

  try {
    popupWindow?.close?.();
  } catch {}
  popupWindow = null;

  sessionStorage.removeItem(SESSION_KEY_POPUP);
  sessionStorage.removeItem(DEPOSIT_KEY);

  updateUI("disconnected");
}

async function ensureClient() {
  if (client && !popupMode) return client;

  if (client && popupMode && popupWindow && !popupWindow.closed) {
    return client;
  }

  if (popupMode && (!popupWindow || popupWindow.closed)) {
    fullyDisconnectLocal();
    throw new Error("Wallet popup was closed");
  }

  throw new Error("Not connected");
}

async function connectInsideIframe() {
  popupMode = false;
  destroyTransport();

  transport = PostMessageTransport.forClient();
  client = new ConnectClient({
    transport,
    dapp: {
      name: "Space Jumper",
      description: "Pay 10 UCT to play",
      url: location.origin,
    },
  });

  const result = await client.connect();

  state.isConnected = true;
  state.isConnecting = false;
  state.identity = result.identity;
  state.permissions = result.permissions || [];
  state.error = null;

  await refreshBalance();
  updateUI("connected");
}

async function connectViaExtension() {
  popupMode = false;
  destroyTransport();

  transport = ExtensionTransport.forClient();
  client = new ConnectClient({
    transport,
    dapp: {
      name: "Space Jumper",
      description: "Pay 10 UCT to play",
      url: location.origin,
    },
  });

  const result = await client.connect();

  state.isConnected = true;
  state.isConnecting = false;
  state.identity = result.identity;
  state.permissions = result.permissions || [];
  state.error = null;

  await refreshBalance();
  updateUI("connected");
}

async function connectViaPopup() {
  popupMode = true;

  if (!popupWindow || popupWindow.closed) {
    popupWindow = window.open(
      WALLET_URL + "/connect?origin=" + encodeURIComponent(location.origin),
      "sphere-wallet",
      "width=420,height=650"
    );

    if (!popupWindow) {
      throw new Error("Popup blocked. Please allow popups for this site.");
    }
  } else {
    popupWindow.focus();
  }

  destroyTransport();

  transport = PostMessageTransport.forClient({
    target: popupWindow,
    targetOrigin: WALLET_URL,
  });

  await waitForHostReady();

  const resumeSessionId = sessionStorage.getItem(SESSION_KEY_POPUP) ?? undefined;

  client = new ConnectClient({
    transport,
    dapp: {
      name: "Space Jumper",
      description: "Pay 10 UCT to play",
      url: location.origin,
    },
    resumeSessionId,
  });

  const result = await client.connect();

  if (result?.sessionId) {
    sessionStorage.setItem(SESSION_KEY_POPUP, result.sessionId);
  }

  state.isConnected = true;
  state.isConnecting = false;
  state.identity = result.identity;
  state.permissions = result.permissions || [];
  state.error = null;

  await refreshBalance();
  updateUI("connected");
}

async function connect() {
  state.isConnecting = true;
  clearError();
  updateUI("connecting");

  try {
    if (isInIframe()) {
      await connectInsideIframe();
      return;
    }

    try {
      await connectViaExtension();
      return;
    } catch (extensionErr) {
      await connectViaPopup();
      return;
    }
  } catch (err) {
    state.isConnecting = false;
    state.isConnected = false;
    state.error = err?.message || "Connection failed";
    updateUI("disconnected");
  }
}

async function disconnect() {
  try {
    await client?.disconnect?.();
  } catch {}

  fullyDisconnectLocal();
}

async function refreshBalance() {
  try {
    const c = await ensureClient();
    const assets = await c.query("sphere_getBalance");

    if (Array.isArray(assets)) {
      const uct = assets.find((a) => a.symbol === COIN_ID);
      if (uct) {
        state.balance = Number(uct.totalAmount) / Math.pow(10, uct.decimals || UCT_DECIMALS);
      } else {
        state.balance = 0;
      }
    } else {
      state.balance = null;
    }
  } catch (err) {
    console.error("Balance fetch failed:", err);
  }
}

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

    const c = await ensureClient();

    await c.intent("send", {
      recipient: GAME_WALLET_ADDRESS,
      amount: ENTRY_FEE,
      coinId: COIN_ID,
    });

    state.error = null;
    await refreshBalance();

    sessionStorage.setItem(DEPOSIT_KEY, "true");
    updateUI("ready");
    return true;
  } catch (err) {
    state.error = err?.message || "Payment failed. Please try again.";
    updateUI("connected");
    return false;
  }
}

async function depositAndRestart() {
  const ok = await deposit();
  if (ok) {
    document.location.reload();
  }
}

function updateUI(phase) {
  const {
    connectBtn,
    walletInfo,
    depositBtn,
    walletBalance,
    walletAddress,
    disconnectBtn,
    errorDiv,
    menuScreen,
    gameScreen,
  } = ui();

  const hideConnect = ["connected", "depositing", "ready", "playing", "gameover"].includes(phase);

  if (connectBtn) connectBtn.style.display = hideConnect ? "none" : "block";
  if (walletInfo) walletInfo.style.display = "none";
  if (depositBtn) depositBtn.style.display = "none";
  if (disconnectBtn) disconnectBtn.style.display = "none";

  if (errorDiv) {
    errorDiv.style.display = state.error ? "block" : "none";
    errorDiv.textContent = state.error || "";
  }

  if (state.isConnected) {
    if (walletAddress) {
      walletAddress.textContent = state.identity?.nametag || "Connected";
    }

    if (walletBalance) {
      walletBalance.textContent =
        state.balance !== null ? `${state.balance} ${COIN_ID}` : "...";
    }
  }

  switch (phase) {
    case "disconnected":
      if (connectBtn) {
        connectBtn.innerHTML = "CONNECT WALLET";
        connectBtn.disabled = false;
      }
      break;

    case "connecting":
      if (connectBtn) {
        connectBtn.innerHTML = "CONNECTING…";
        connectBtn.disabled = true;
      }
      break;

    case "connected":
      if (walletInfo) walletInfo.style.display = "block";
      if (disconnectBtn) disconnectBtn.style.display = "inline-block";

      if (state.identity?.nametag && depositBtn) {
        depositBtn.style.display = "block";
        depositBtn.innerHTML = `PLAY <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled = false;
      }
      break;

    case "depositing":
      if (walletInfo) walletInfo.style.display = "block";

      if (depositBtn) {
        depositBtn.style.display = "block";
        depositBtn.innerHTML = "CONFIRMING…";
        depositBtn.disabled = true;
      }
      break;

    case "ready":
      if (walletInfo) walletInfo.style.display = "block";
      if (disconnectBtn) disconnectBtn.style.display = "inline-block";

      if (menuScreen) menuScreen.style.display = "none";
      if (gameScreen) gameScreen.style.display = "flex";

      if (window._onWalletReady) {
        window._onWalletReady();
      }
      break;

    case "playing":
      if (walletInfo) walletInfo.style.display = "block";
      break;

    case "gameover":
      if (walletInfo) walletInfo.style.display = "block";

      if (depositBtn) {
        depositBtn.style.display = "block";
        depositBtn.innerHTML = `PLAY AGAIN <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled = false;
      }
      break;
  }
}

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
      await waitForHostReady(5000);

      popupMode = false;
      destroyTransport();

      transport = PostMessageTransport.forClient();
      client = new ConnectClient({
        transport,
        dapp: {
          name: "Space Jumper",
          description: "Pay 10 UCT to play",
          url: location.origin,
        },
        silent: true,
      });

      const result = await client.connect();
      state.isConnected = true;
      state.identity = result.identity;
      state.permissions = result.permissions || [];
      state.error = null;
      await refreshBalance();
      updateUI("connected");
      return;
    }

    try {
      popupMode = false;
      destroyTransport();

      transport = ExtensionTransport.forClient();
      client = new ConnectClient({
        transport,
        dapp: {
          name: "Space Jumper",
          description: "Pay 10 UCT to play",
          url: location.origin,
        },
        silent: true,
      });

      const result = await client.connect();
      state.isConnected = true;
      state.identity = result.identity;
      state.permissions = result.permissions || [];
      state.error = null;
      await refreshBalance();
      updateUI("connected");
      return;
    } catch {}

    const savedSession = sessionStorage.getItem(SESSION_KEY_POPUP);
    if (savedSession) {
      popupMode = true;

      popupWindow = window.open(
        WALLET_URL + "/connect?origin=" + encodeURIComponent(location.origin),
        "sphere-wallet",
        "width=420,height=650"
      );

      if (!popupWindow) throw new Error("Popup blocked");

      destroyTransport();

      transport = PostMessageTransport.forClient({
        target: popupWindow,
        targetOrigin: WALLET_URL,
      });

      await waitForHostReady(5000);

      client = new ConnectClient({
        transport,
        dapp: {
          name: "Space Jumper",
          description: "Pay 10 UCT to play",
          url: location.origin,
        },
        resumeSessionId: savedSession,
        silent: true,
      });

      const result = await client.connect();
      if (result?.sessionId) sessionStorage.setItem(SESSION_KEY_POPUP, result.sessionId);

      state.isConnected = true;
      state.identity = result.identity;
      state.permissions = result.permissions || [];
      state.error = null;
      await refreshBalance();
      updateUI("connected");
      return;
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

window.SphereWallet = {
  get isConnected() {
    return state.isConnected;
  },
  get identity() {
    return state.identity;
  },
  get balance() {
    return state.balance;
  },
  get error() {
    return state.error;
  },
  get entryFee() {
    return ENTRY_FEE;
  },
  get coinId() {
    return COIN_ID;
  },
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
    sessionStorage.removeItem(DEPOSIT_KEY);
  },
};
