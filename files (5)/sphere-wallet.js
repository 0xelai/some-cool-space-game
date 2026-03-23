// Space Jumper — Sphere Wallet Integration
// Based on @unicitylabs/sphere-sdk

const WALLET_URL = 'https://sphere.unicity.network';
const GAME_WALLET_ADDRESS = '@elaiii';
const ENTRY_FEE = 10;
const COIN_ID = 'UCT';
const UCT_COIN_ID_HEX = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
const UCT_DECIMALS = 18;
const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const SESSION_KEY = 'spacejumper-sphere-session';
const DEPOSIT_KEY = 'spacejumper-deposit-paid';

const state = {
  isConnected: false,
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
let sdkReady = false;
let ConnectClient, PostMessageTransport, ExtensionTransport, INTENT_ACTIONS, HOST_READY_TYPE;

// ── Load SDK ──────────────────────────────────────────────────────────────
async function loadSDK() {
  if (sdkReady) return true;
  try {
    // Try loading the compiled Boxy-Run version first (most compatible)
    const connectMod = await import('https://esm.sh/@unicitylabs/sphere-sdk/connect');
    ConnectClient    = connectMod.ConnectClient;
    HOST_READY_TYPE  = connectMod.HOST_READY_TYPE;
    INTENT_ACTIONS   = connectMod.INTENT_ACTIONS;

    const browserMod = await import('https://esm.sh/@unicitylabs/sphere-sdk/connect/browser');
    PostMessageTransport = browserMod.PostMessageTransport;
    ExtensionTransport   = browserMod.ExtensionTransport;
    sdkReady = true;
    return true;
  } catch (err) {
    console.warn('Sphere SDK load error:', err);
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function isInIframe() {
  try { return window.parent !== window; } catch { return true; }
}
function hasExtension() {
  try {
    return window.sphere?.isInstalled?.() === true;
  } catch { return false; }
}

// Wait for popup to signal it's ready — with generous timeout
function waitForHostReady(ms = 60000) {
  return new Promise((resolve, reject) => {
    // If HOST_READY_TYPE is undefined the SDK handles it internally — just resolve
    if (!HOST_READY_TYPE) { resolve(); return; }

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Sphere wallet popup timed out. Please try again.'));
    }, ms);

    function handler(e) {
      if (e.data && e.data.type === HOST_READY_TYPE) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

const dappMeta = {
  name: 'Space Jumper',
  description: 'A 2D space platformer · pay 10 UCT to play',
  url: location.origin,
};

// ── Connect ───────────────────────────────────────────────────────────────
async function connect() {
  updateUI('connecting');
  state.error = null;

  if (!await loadSDK()) {
    state.error = 'Could not load Sphere SDK. Check your internet.';
    updateUI('disconnected');
    return;
  }

  try {
    if (isInIframe()) {
      // Embedded in iframe (e.g. Sphere web app)
      transport = PostMessageTransport.forClient();
      client = new ConnectClient({ transport, dapp: dappMeta });
      const r = await client.connect();
      state.isConnected = true;
      state.identity = r.identity;
      sessionStorage.setItem(SESSION_KEY, r.sessionId);

    } else if (hasExtension()) {
      // Browser extension installed
      transport = ExtensionTransport.forClient();
      client = new ConnectClient({ transport, dapp: dappMeta });
      const r = await client.connect();
      state.isConnected = true;
      state.identity = r.identity;

    } else {
      // Popup mode (standard for localhost / hosted pages)
      if (!popupWindow || popupWindow.closed) {
        popupWindow = window.open(
          `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
          'sphere-wallet',
          'width=420,height=650,left=200,top=100'
        );
        if (!popupWindow) {
          throw new Error('Popup was blocked. Please allow popups for this page and try again.');
        }
      }

      transport?.destroy?.();
      transport = PostMessageTransport.forClient({
        target: popupWindow,
        targetOrigin: WALLET_URL,
      });

      // Wait for popup to signal ready (generous 60s — user may need to log in)
      await waitForHostReady(60000);

      const resumeId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
      client = new ConnectClient({ transport, dapp: dappMeta, resumeSessionId: resumeId });
      const r = await client.connect();
      state.isConnected = true;
      state.identity = r.identity;
      sessionStorage.setItem(SESSION_KEY, r.sessionId);
    }

    if (!state.identity?.nametag) {
      state.error = 'No Unicity ID found. Please register one in Sphere to play.';
      updateUI('connected');
      return;
    }

    await refreshBalance();
    state.error = null;

    // If deposit was paid before a reload, restore it
    if (sessionStorage.getItem(DEPOSIT_KEY)) {
      sessionStorage.removeItem(DEPOSIT_KEY);
      state.isDepositPaid = true;
      updateUI('ready');
    } else {
      updateUI('connected');
    }

  } catch (err) {
    state.error = err.message || 'Connection failed';
    state.isConnected = false;
    updateUI('disconnected');
  }
}

async function disconnect() {
  try { await client?.disconnect(); } catch {}
  transport?.destroy?.();
  client = null; transport = null;
  popupWindow?.close(); popupWindow = null;
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(DEPOSIT_KEY);
  Object.assign(state, { isConnected: false, isDepositPaid: false, identity: null, balance: null, error: null });
  updateUI('disconnected');
}

async function refreshBalance() {
  if (!client) return;
  try {
    const assets = await client.query('sphere_getBalance');
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
  } catch (e) {
    console.error('Balance fetch failed:', e);
  }
}

async function deposit() {
  if (!client || !state.isConnected) { state.error = 'Not connected'; return false; }
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
    await client.intent(INTENT_ACTIONS.SEND, {
      to: GAME_WALLET_ADDRESS,
      amount: ENTRY_FEE,
      coinId: uctCoinId || UCT_COIN_ID_HEX,
      memo: 'Space Jumper entry fee',
    });
    state.isDepositPaid = true;
    state.error = null;
    await refreshBalance();
    updateUI('ready');
    return true;
  } catch (err) {
    state.error = err.message || 'Payment failed. Please try again.';
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

// ── UI updates ────────────────────────────────────────────────────────────
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

  // Reset buttons — never hide connect btn, only hide deposit
  if (connectBtn)    connectBtn.style.display    = phase === 'connected' || phase === 'depositing' || phase === 'ready' || phase === 'playing' || phase === 'gameover' ? 'none' : 'block';
  if (walletInfo)    walletInfo.style.display    = 'none';
  if (depositBtn)    depositBtn.style.display    = 'none';
  if (disconnectBtn) disconnectBtn.style.display = 'none';

  // Error
  if (errorDiv) {
    errorDiv.style.display  = state.error ? 'block' : 'none';
    errorDiv.textContent    = state.error || '';
  }

  // Wallet info when connected
  if (state.isConnected) {
    if (walletAddress) walletAddress.textContent = state.identity?.nametag || 'Connected';
    if (walletBalance) walletBalance.textContent = state.balance !== null ? `${state.balance} ${COIN_ID}` : '...';
  }

  switch (phase) {
    case 'disconnected':
      if (connectBtn) { connectBtn.style.display = 'block'; connectBtn.innerHTML = 'CONNECT WALLET'; connectBtn.disabled = false; }
      break;
    case 'connecting':
      if (connectBtn) { connectBtn.style.display = 'block'; connectBtn.innerHTML = 'CONNECTING…'; connectBtn.disabled = true; }
      break;
    case 'connected':
      if (walletInfo)    walletInfo.style.display    = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
      if (state.identity?.nametag) {
        if (depositBtn) { depositBtn.style.display = 'block'; depositBtn.innerHTML = `PLAY <span class="uct-badge">${ENTRY_FEE} ${COIN_ID}</span>`; depositBtn.disabled = false; }
      }
      break;
    case 'depositing':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) { depositBtn.style.display = 'block'; depositBtn.textContent = 'CONFIRMING…'; depositBtn.disabled = true; }
      break;
    case 'ready':
      if (walletInfo)    walletInfo.style.display    = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
      // Hide menu, show game
      if (menuScreen) menuScreen.style.display = 'none';
      if (gameScreen) gameScreen.style.display = 'flex';
      // Notify game to start immediately — no "press space" needed
      if (window._onWalletReady) window._onWalletReady();
      break;
    case 'playing':
      if (walletInfo) walletInfo.style.display = 'block';
      break;
    case 'gameover':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) { depositBtn.style.display = 'block'; depositBtn.textContent = `Play Again (${ENTRY_FEE} ${COIN_ID})`; depositBtn.disabled = false; }
      break;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  document.getElementById('sphere-connect-btn')?.addEventListener('click', connect);
  document.getElementById('sphere-deposit-btn')?.addEventListener('click', depositAndRestart);
  document.getElementById('sphere-disconnect-btn')?.addEventListener('click', disconnect);

  // Restore deposit state if page was reloaded after paying
  if (sessionStorage.getItem(DEPOSIT_KEY)) state.isDepositPaid = true;

  // Try auto-reconnect
  const hasSession = isInIframe() || hasExtension() || sessionStorage.getItem(SESSION_KEY);
  if (hasSession) connect();
  else updateUI('disconnected');
});

// Poll for popup close
setInterval(() => {
  if (state.isConnected && popupWindow && popupWindow.closed) disconnect();
}, 1000);

// ── Global API (used by game.js like Boxy-Run does) ───────────────────────
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
