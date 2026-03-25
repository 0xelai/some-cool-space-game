// Space Jumper — Sphere Wallet Integration
// Static-site friendly version with improved handshake handling

const WALLET_ORIGIN = 'https://sphere.unicity.network';
const WALLET_URL = `${WALLET_ORIGIN}/connect?origin=${encodeURIComponent(window.location.origin)}`;

const GAME_WALLET_ADDRESS = '@elaiii';
const ENTRY_FEE = 10;
const COIN_ID = 'UCT';
const SESSION_KEY = 'spacejumper-sphere-session';
const DEPOSIT_KEY = 'spacejumper-deposit-paid';

const READY_EVENTS = new Set([
  'sphere-connect:host-ready',
  'HOST_READY',
  'SPHERE_HOST_READY'
]);

const state = {
  isConnected: false,
  isDepositPaid: false,
  identity: null,
  balance: null,
  error: null
};

let popupWindow = null;
let pendingReqs = {};
let reqCounter = 1;
let msgListener = null;

let readyPingInterval = null;
let connectTimeout = null;
let hostReadyReceived = false;
let connectInFlight = false;

function log(...args) {
  console.log('[SphereWallet]', ...args);
}

function clearPendingReqs(reason = 'Cancelled') {
  for (const id of Object.keys(pendingReqs)) {
    pendingReqs[id].reject(new Error(reason));
    delete pendingReqs[id];
  }
}

function stopReadyPing() {
  if (readyPingInterval) {
    clearInterval(readyPingInterval);
    readyPingInterval = null;
  }
}

function clearConnectTimeout() {
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
}

function cleanupHandshake() {
  stopReadyPing();
  clearConnectTimeout();
  hostReadyReceived = false;
  connectInFlight = false;
}

function sendToWallet(msg) {
  if (popupWindow && !popupWindow.closed) {
    popupWindow.postMessage(msg, WALLET_ORIGIN);
  }
}

function rpc(method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = String(reqCounter++);
    pendingReqs[id] = { resolve, reject };

    sendToWallet({
      jsonrpc: '2.0',
      id,
      method,
      params
    });

    setTimeout(() => {
      if (pendingReqs[id]) {
        delete pendingReqs[id];
        reject(new Error(`"${method}" timed out`));
      }
    }, timeoutMs);
  });
}

function startListening() {
  if (msgListener) return;

  msgListener = (event) => {
    if (event.origin !== WALLET_ORIGIN) return;
    if (popupWindow && event.source && event.source !== popupWindow) return;

    const d = event.data;
    if (!d) return;

    log('wallet message:', d);

    const type = typeof d === 'object' ? d.type : null;

    if (type && READY_EVENTS.has(type)) {
      hostReadyReceived = true;
      stopReadyPing();
      clearConnectTimeout();
      doConnect();
      return;
    }

    if (type === 'SPHERE_DISCONNECT' || type === 'DISCONNECT' || type === 'sphere-connect:disconnect') {
      disconnect();
      return;
    }

    if (d.jsonrpc === '2.0' && d.id && pendingReqs[d.id]) {
      const { resolve, reject } = pendingReqs[d.id];
      delete pendingReqs[d.id];

      if (d.error) {
        reject(new Error(d.error.message || 'RPC error'));
      } else {
        resolve(d.result);
      }
    }
  };

  window.addEventListener('message', msgListener);
}

function stopListening() {
  if (msgListener) {
    window.removeEventListener('message', msgListener);
    msgListener = null;
  }
}

function startReadyPing() {
  stopReadyPing();

  readyPingInterval = setInterval(() => {
    if (!popupWindow || popupWindow.closed || hostReadyReceived) return;

    // Keep both forms to maximize compatibility with current/older wallet flows
    sendToWallet({
      type: 'DAPP_READY',
      origin: window.location.origin,
      dapp: {
        name: 'Space Jumper',
        description: 'Pay 10 UCT to play',
        url: window.location.origin
      }
    });

    sendToWallet({
      type: 'sphere-connect:dapp-ready',
      origin: window.location.origin,
      dapp: {
        name: 'Space Jumper',
        description: 'Pay 10 UCT to play',
        url: window.location.origin
      }
    });

    log('sent ready ping');
  }, 700);
}

function startConnectTimeout() {
  clearConnectTimeout();

  connectTimeout = setTimeout(() => {
    if (!hostReadyReceived) {
      state.error = 'Wallet popup opened, but no ready signal came back.';
      updateUI('disconnected');
      cleanupHandshake();
    }
  }, 20000);
}

async function doConnect() {
  if (connectInFlight) return;
  connectInFlight = true;

  try {
    const resume = sessionStorage.getItem(SESSION_KEY) || undefined;

    const result = await rpc('sphere_connect', {
      dapp: {
        name: 'Space Jumper',
        description: 'Pay 10 UCT to play',
        url: window.location.origin
      },
      sessionId: resume
    });

    log('sphere_connect result:', result);

    state.isConnected = true;
    state.identity = result?.identity || null;
    state.error = null;

    if (result?.sessionId) {
      sessionStorage.setItem(SESSION_KEY, result.sessionId);
    }

    await refreshBalance();

    if (sessionStorage.getItem(DEPOSIT_KEY)) {
      state.isDepositPaid = true;
      updateUI('ready');
    } else {
      updateUI('connected');
    }

    cleanupHandshake();
  } catch (err) {
    log('connect failed:', err);
    state.error = err?.message || 'Connection failed';
    state.isConnected = false;
    updateUI('disconnected');
    cleanupHandshake();
  }
}

async function connect() {
  state.error = null;
  updateUI('connecting');
  startListening();

  try {
    if (!popupWindow || popupWindow.closed) {
      popupWindow = window.open(
        WALLET_URL,
        'sphere-wallet',
        'width=430,height=660,left=200,top=80'
      );

      if (!popupWindow) {
        throw new Error('Popup blocked. Please allow popups for this site and try again.');
      }
    } else {
      popupWindow.focus();
    }

    hostReadyReceived = false;
    startReadyPing();
    startConnectTimeout();
  } catch (err) {
    state.error = err?.message || 'Failed to open wallet popup';
    state.isConnected = false;
    updateUI('disconnected');
    cleanupHandshake();
  }
}

async function disconnect() {
  try {
    sendToWallet({
      jsonrpc: '2.0',
      id: String(reqCounter++),
      method: 'sphere_disconnect',
      params: {}
    });
  } catch {}

  try {
    popupWindow?.close();
  } catch {}

  popupWindow = null;

  cleanupHandshake();
  stopListening();
  clearPendingReqs('Disconnected');

  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(DEPOSIT_KEY);

  state.isConnected = false;
  state.isDepositPaid = false;
  state.identity = null;
  state.balance = null;
  state.error = null;

  updateUI('disconnected');
}

async function refreshBalance() {
  if (!state.isConnected) return;

  try {
    const assets = await rpc('sphere_getBalance', {});
    log('sphere_getBalance result:', assets);

    if (Array.isArray(assets)) {
      const uct = assets.find((a) => a.symbol === COIN_ID);
      state.balance = uct ? Number(uct.totalAmount) / Math.pow(10, uct.decimals || 18) : 0;
    }
  } catch (e) {
    console.error('Balance fetch failed:', e);
  }
}

async function deposit() {
  if (!state.isConnected) {
    state.error = 'Not connected';
    updateUI('disconnected');
    return false;
  }

  if (state.balance !== null && state.balance < ENTRY_FEE) {
    state.error = `Not enough balance. Need at least ${ENTRY_FEE} ${COIN_ID}.`;
    updateUI('connected');
    return false;
  }

  try {
    updateUI('depositing');

    const result = await rpc('sphere_sendTransaction', {
      to: GAME_WALLET_ADDRESS,
      amount: String(ENTRY_FEE),
      coinId: COIN_ID,
      memo: 'Space Jumper entry fee'
    });

    log('sphere_sendTransaction result:', result);

    state.isDepositPaid = true;
    state.error = null;

    sessionStorage.setItem(DEPOSIT_KEY, 'true');
    await refreshBalance();
    updateUI('ready');
    return true;
  } catch (err) {
    console.error('Payment failed:', err);
    state.error = err?.message || 'Payment failed. Please try again.';
    state.isDepositPaid = false;
    updateUI('connected');
    return false;
  }
}

async function depositAndRestart() {
  const ok = await deposit();
  if (ok) {
    window.location.reload();
  }
}

function updateUI(phase) {
  const connectBtn = document.getElementById('sphere-connect-btn');
  const walletInfo = document.getElementById('sphere-wallet-info');
  const depositBtn = document.getElementById('sphere-deposit-btn');
  const walletBalance = document.getElementById('sphere-balance');
  const walletAddress = document.getElementById('sphere-address');
  const disconnectBtn = document.getElementById('sphere-disconnect-btn');
  const errorDiv = document.getElementById('sphere-error');
  const menuScreen = document.getElementById('menu-screen');
  const gameScreen = document.getElementById('game-screen');

  const hideConnect = ['connected', 'depositing', 'ready', 'playing', 'gameover'].includes(phase);

  if (connectBtn) connectBtn.style.display = hideConnect ? 'none' : 'block';
  if (walletInfo) walletInfo.style.display = 'none';
  if (depositBtn) depositBtn.style.display = 'none';
  if (disconnectBtn) disconnectBtn.style.display = 'none';

  if (errorDiv) {
    errorDiv.style.display = state.error ? 'block' : 'none';
    errorDiv.textContent = state.error || '';
  }

  if (state.isConnected) {
    if (walletAddress) walletAddress.textContent = state.identity?.nametag || 'Connected';
    if (walletBalance) walletBalance.textContent = state.balance !== null ? `${state.balance} ${COIN_ID}` : '...';
  }

  switch (phase) {
    case 'disconnected':
      if (connectBtn) {
        connectBtn.innerHTML = 'CONNECT WALLET';
        connectBtn.disabled = false;
      }
      break;

    case 'connecting':
      if (connectBtn) {
        connectBtn.innerHTML = 'CONNECTING…';
        connectBtn.disabled = true;
      }
      break;

    case 'connected':
      if (walletInfo) walletInfo.style.display = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';

      if (depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.innerHTML = `PLAY <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled = false;
      }
      break;

    case 'depositing':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.innerHTML = 'CONFIRMING…';
        depositBtn.disabled = true;
      }
      break;

    case 'ready':
      if (walletInfo) walletInfo.style.display = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
      if (menuScreen) menuScreen.style.display = 'none';
      if (gameScreen) gameScreen.style.display = 'flex';
      if (window._onWalletReady) window._onWalletReady();
      break;

    case 'playing':
      if (walletInfo) walletInfo.style.display = 'block';
      break;

    case 'gameover':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.innerHTML = `PLAY AGAIN <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled = false;
      }
      break;
  }
}

window.addEventListener('load', () => {
  document.getElementById('sphere-connect-btn')?.addEventListener('click', connect);
  document.getElementById('sphere-deposit-btn')?.addEventListener('click', depositAndRestart);
  document.getElementById('sphere-disconnect-btn')?.addEventListener('click', disconnect);

  if (sessionStorage.getItem(DEPOSIT_KEY)) {
    state.isDepositPaid = true;
  }

  if (sessionStorage.getItem(SESSION_KEY)) {
    connect();
  } else {
    updateUI('disconnected');
  }
});

setInterval(() => {
  if ((state.isConnected || connectInFlight) && popupWindow && popupWindow.closed) {
    state.error = state.isConnected ? null : 'Wallet popup was closed.';
    disconnect();
  }
}, 1000);

window.SphereWallet = {
  get isConnected() { return state.isConnected; },
  get isDepositPaid() { return state.isDepositPaid; },
  get identity() { return state.identity; },
  get balance() { return state.balance; },
  get error() { return state.error; },
  get entryFee() { return ENTRY_FEE; },
  get coinId() { return COIN_ID; },

  connect,
  disconnect,
  deposit,
  depositAndRestart,
  refreshBalance,

  resetDeposit() {
    state.isDepositPaid = false;
    sessionStorage.removeItem(DEPOSIT_KEY);
  }
};
