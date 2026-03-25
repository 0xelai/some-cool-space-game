// Space Jumper — Sphere Wallet Integration
// Direct postMessage protocol — no external SDK dependency
// Mirrors the exact behaviour of Boxy-Run's sphere-connect.ts

const WALLET_URL          = 'https://sphere.unicity.network';
const GAME_WALLET_ADDRESS = '@elaiii';
const ENTRY_FEE           = 10;
const COIN_ID             = 'UCT';
const UCT_COIN_ID_HEX     = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
const UCT_DECIMALS        = 18;
const FAUCET_URL          = 'https://faucet.unicity.network/api/v1/faucet/request';
const SESSION_KEY         = 'spacejumper-sphere-session';
const DEPOSIT_KEY         = 'spacejumper-deposit-paid';

const state = {
  isConnected:   false,
  isDepositPaid: false,
  identity:      null,
  balance:       null,
  error:         null,
};

let popupWindow = null;
let pendingReqs = {};
let reqCounter  = 1;
let uctCoinId   = null;
let uctDecimals = UCT_DECIMALS;
let msgListener = null;

// ── postMessage RPC ────────────────────────────────────────────────────────
function sendToWallet(msg) {
  if (popupWindow && !popupWindow.closed) {
    popupWindow.postMessage(msg, WALLET_URL);
  }
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(reqCounter++);
    pendingReqs[id] = { resolve, reject };
    sendToWallet({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pendingReqs[id]) {
        delete pendingReqs[id];
        reject(new Error(`"${method}" timed out`));
      }
    }, 60000);
  });
}

function startListening() {
  if (msgListener) return;
  msgListener = (event) => {
    if (event.origin !== WALLET_URL) return;
    const d = event.data;
    if (!d) return;

    // Wallet is ready — initiate connect handshake
    if (d.type === 'sphere-connect:host-ready' || d.type === 'SPHERE_HOST_READY' || d.type === 'HOST_READY') {
      doConnect();
      return;
    }

    // JSON-RPC response
    if (d.jsonrpc === '2.0' && d.id && pendingReqs[d.id]) {
      const { resolve, reject } = pendingReqs[d.id];
      delete pendingReqs[d.id];
      if (d.error) reject(new Error(d.error.message || 'RPC error'));
      else resolve(d.result);
      return;
    }

    // Wallet-initiated disconnect
    if (d.type === 'sphere-connect:disconnect' || d.type === 'SPHERE_DISCONNECT' || d.type === 'DISCONNECT') {
      disconnect();
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

// ── Called once wallet popup signals ready ─────────────────────────────────
async function doConnect() {
  try {
    const resume = sessionStorage.getItem(SESSION_KEY) || undefined;
    const result = await rpc('sphere_connect', {
      dapp: {
        name: 'Space Jumper',
        description: 'Pay 10 UCT to play',
        url: location.origin,
      },
      sessionId: resume,
    });

    state.isConnected = true;
    state.identity    = result.identity;
    if (result.sessionId) sessionStorage.setItem(SESSION_KEY, result.sessionId);

    if (!state.identity?.nametag) {
      state.error = 'No Unicity ID found. Please register one in Sphere.';
      updateUI('connected');
      return;
    }

    await refreshBalance();
    state.error = null;

    if (sessionStorage.getItem(DEPOSIT_KEY)) {
      sessionStorage.removeItem(DEPOSIT_KEY);
      state.isDepositPaid = true;
      updateUI('ready');
    } else {
      updateUI('connected');
    }
  } catch (err) {
    state.error       = err.message || 'Connection failed';
    state.isConnected = false;
    updateUI('disconnected');
  }
}

// ── Public connect ─────────────────────────────────────────────────────────
async function connect() {
  updateUI('connecting');
  state.error = null;
  startListening();

  try {
    if (!popupWindow || popupWindow.closed) {
      popupWindow = window.open(
        `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
        'sphere-wallet',
        'width=430,height=660,left=200,top=80'
      );
      if (!popupWindow) {
        throw new Error('Popup blocked. Please allow popups for this site and try again.');
      }
    }
    // If popup already open, nudge it
    setTimeout(() => sendToWallet({ type: 'DAPP_READY', origin: location.origin }), 900);
  } catch (err) {
    state.error       = err.message;
    state.isConnected = false;
    updateUI('disconnected');
  }
}

async function disconnect() {
  try { sendToWallet({ jsonrpc: '2.0', id: String(reqCounter++), method: 'sphere_disconnect', params: {} }); } catch {}
  popupWindow?.close();
  popupWindow = null;
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(DEPOSIT_KEY);
  stopListening();
  Object.assign(state, { isConnected: false, isDepositPaid: false, identity: null, balance: null, error: null });
  updateUI('disconnected');
}

async function refreshBalance() {
  if (!state.isConnected) return;
  try {
    const assets = await rpc('sphere_getBalance', {});
    if (Array.isArray(assets)) {
      const uct = assets.find(a => a.symbol === COIN_ID);
      if (uct) {
        uctCoinId     = uct.coinId;
        uctDecimals   = uct.decimals || UCT_DECIMALS;
        state.balance = Number(uct.totalAmount) / Math.pow(10, uctDecimals);
      } else {
        uctCoinId     = UCT_COIN_ID_HEX;
        state.balance = 0;
      }
    }
  } catch (e) { console.error('Balance fetch failed:', e); }
}

async function deposit() {
  if (!state.isConnected) { state.error = 'Not connected'; return false; }
  if (!state.identity?.nametag) {
    state.error = 'Unicity ID required. Register one in Sphere.';
    updateUI('connected'); return false;
  }
  if (state.balance !== null && state.balance < ENTRY_FEE) {
    state.error = `Not enough balance. Need at least ${ENTRY_FEE} ${COIN_ID}.`;
    updateUI('connected'); return false;
  }
  try {
    updateUI('depositing');
    await rpc('sphere_sendTransaction', {
      to:     GAME_WALLET_ADDRESS,
      amount: String(ENTRY_FEE),
      coinId: uctCoinId || UCT_COIN_ID_HEX,
      memo:   'Space Jumper entry fee',
    });
    state.isDepositPaid = true;
    state.error = null;
    await refreshBalance();
    updateUI('ready');
    return true;
  } catch (err) {
    state.error         = err.message || 'Payment failed. Please try again.';
    state.isDepositPaid = false;
    updateUI('connected');
    return false;
  }
}

async function depositAndRestart() {
  const ok = await deposit();
  if (ok) {
    sessionStorage.setItem(DEPOSIT_KEY, 'true');
    document.location.reload();
  }
}

async function requestPayout(coins) {
  if (coins <= 0 || !state.identity) return false;
  const unicityId = (state.identity.nametag || '').replace(/^@/, '');
  if (!unicityId) return false;
  try {
    const r = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unicityId, coin: 'unicity', amount: coins }),
    });
    return r.ok;
  } catch { return false; }
}

// ── UI ─────────────────────────────────────────────────────────────────────
function updateUI(phase) {
  const connectBtn    = document.getElementById('sphere-connect-btn');
  const walletInfo    = document.getElementById('sphere-wallet-info');
  const depositBtn    = document.getElementById('sphere-deposit-btn');
  const walletBalance = document.getElementById('sphere-balance');
  const walletAddress = document.getElementById('sphere-address');
  const disconnectBtn = document.getElementById('sphere-disconnect-btn');
  const errorDiv      = document.getElementById('sphere-error');
  const menuScreen    = document.getElementById('menu-screen');
  const gameScreen    = document.getElementById('game-screen');

  const hideConnect = ['connected','depositing','ready','playing','gameover'].includes(phase);
  if (connectBtn)    connectBtn.style.display    = hideConnect ? 'none' : 'block';
  if (walletInfo)    walletInfo.style.display    = 'none';
  if (depositBtn)    depositBtn.style.display    = 'none';
  if (disconnectBtn) disconnectBtn.style.display = 'none';

  if (errorDiv) {
    errorDiv.style.display = state.error ? 'block' : 'none';
    errorDiv.textContent   = state.error || '';
  }

  if (state.isConnected) {
    if (walletAddress) walletAddress.textContent = state.identity?.nametag || 'Connected';
    if (walletBalance) walletBalance.textContent =
      state.balance !== null ? `${state.balance} ${COIN_ID}` : '...';
  }

  switch (phase) {
    case 'disconnected':
      if (connectBtn) { connectBtn.innerHTML = 'CONNECT WALLET'; connectBtn.disabled = false; }
      break;
    case 'connecting':
      if (connectBtn) { connectBtn.innerHTML = 'CONNECTING…'; connectBtn.disabled = true; }
      break;
    case 'connected':
      if (walletInfo)    walletInfo.style.display    = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
      if (state.identity?.nametag && depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.innerHTML     = `PLAY <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled      = false;
      }
      break;
    case 'depositing':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) { depositBtn.style.display = 'block'; depositBtn.innerHTML = 'CONFIRMING…'; depositBtn.disabled = true; }
      break;
    case 'ready':
      if (walletInfo)    walletInfo.style.display    = 'block';
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
        depositBtn.innerHTML     = `PLAY AGAIN <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`;
        depositBtn.disabled      = false;
      }
      break;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  document.getElementById('sphere-connect-btn')?.addEventListener('click', connect);
  document.getElementById('sphere-deposit-btn')?.addEventListener('click', depositAndRestart);
  document.getElementById('sphere-disconnect-btn')?.addEventListener('click', disconnect);

  if (sessionStorage.getItem(DEPOSIT_KEY)) state.isDepositPaid = true;

  // Auto-reconnect if we have a saved session
  if (sessionStorage.getItem(SESSION_KEY)) connect();
  else updateUI('disconnected');
});

// Poll for popup close
setInterval(() => {
  if (state.isConnected && popupWindow && popupWindow.closed) disconnect();
}, 1000);

// ── Global API ────────────────────────────────────────────────────────────
window.SphereWallet = {
  get isConnected()   { return state.isConnected; },
  get isDepositPaid() { return state.isDepositPaid; },
  get identity()      { return state.identity; },
  get balance()       { return state.balance; },
  get error()         { return state.error; },
  get entryFee()      { return ENTRY_FEE; },
  get coinId()        { return COIN_ID; },
  connect, disconnect, deposit, depositAndRestart,
  requestPayout, refreshBalance, updateUI,
  resetDeposit() { state.isDepositPaid = false; },
};
