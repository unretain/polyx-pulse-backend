import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for mobile app
app.use(cors());
app.use(express.json());

// In-memory token storage (keeps last 5 minutes of tokens)
interface Token {
  address: string;
  symbol: string;
  name: string;
  logo?: string;
  price: number;
  marketCap: number;
  bondingProgress?: number;
  createdAt: string;
  fetchedAt: number;
}

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOKENS = 100;
let tokens: Token[] = [];

// Clean up old tokens periodically
function cleanupOldTokens() {
  const cutoff = Date.now() - MAX_AGE_MS;
  tokens = tokens.filter((t) => t.fetchedAt > cutoff);
}

// Add token to the list
function addToken(token: Token) {
  // Remove duplicates
  tokens = tokens.filter((t) => t.address !== token.address);
  // Add to front
  tokens.unshift(token);
  // Keep only MAX_TOKENS
  if (tokens.length > MAX_TOKENS) {
    tokens = tokens.slice(0, MAX_TOKENS);
  }
}

// Fetch actual image URL from metadata
async function fetchImageFromMetadata(metadataUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as { image?: string };
    if (metadata.image) {
      // Handle IPFS URLs in metadata
      if (metadata.image.startsWith('ipfs://')) {
        return `https://ipfs.io/ipfs/${metadata.image.replace('ipfs://', '')}`;
      }
      return metadata.image;
    }
  } catch {
    // Timeout or error - just skip
  }
  return undefined;
}

// PumpPortal WebSocket connection
const PUMP_PORTAL_WS = 'wss://pumpportal.fun/api/data';
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;

function connectToPumpPortal() {
  console.log('[PumpPortal] Connecting...');

  ws = new WebSocket(PUMP_PORTAL_WS);

  ws.on('open', () => {
    console.log('[PumpPortal] Connected!');
    reconnectAttempts = 0;

    // Subscribe to new token events
    ws?.send(
      JSON.stringify({
        method: 'subscribeNewToken',
      })
    );
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Handle new token creation events
      if (message.txType === 'create' && message.mint) {
        // Build metadata URL to fetch the actual image
        let logo: string | undefined;
        let metadataUrl: string | undefined;

        if (message.uri) {
          if (message.uri.startsWith('ipfs://')) {
            metadataUrl = `https://ipfs.io/ipfs/${message.uri.replace('ipfs://', '')}`;
          } else if (message.uri.startsWith('http')) {
            metadataUrl = message.uri;
          } else {
            metadataUrl = `https://ipfs.io/ipfs/${message.uri}`;
          }
        }

        // Use pump.fun's direct image endpoint (works with mint address)
        logo = `https://pump.fun/coin/${message.mint}/image`;

        const token: Token = {
          address: message.mint,
          symbol: message.symbol || 'UNKNOWN',
          name: message.name || 'Unknown Token',
          logo,
          price: 0.000001, // Initial price estimate
          marketCap: message.marketCapSol ? message.marketCapSol * 185 : 0, // Rough USD conversion
          bondingProgress: message.vSolInBondingCurve
            ? (message.vSolInBondingCurve / 85) * 100
            : 0,
          createdAt: new Date().toISOString(),
          fetchedAt: Date.now(),
        };

        addToken(token);
        console.log(`[PumpPortal] New token: ${token.symbol} (${token.address.slice(0, 8)}...)`);

        // Async: Try to fetch better image from metadata (don't block)
        if (metadataUrl) {
          fetchImageFromMetadata(metadataUrl).then((imageUrl) => {
            if (imageUrl) {
              // Update token with actual image
              const idx = tokens.findIndex((t) => t.address === token.address);
              if (idx !== -1) {
                tokens[idx].logo = imageUrl;
              }
            }
          });
        }
      }
    } catch (err) {
      // Ignore parse errors for non-JSON messages
    }
  });

  ws.on('close', () => {
    console.log('[PumpPortal] Disconnected');
    ws = null;

    // Attempt reconnection
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(
        `[PumpPortal] Reconnecting in ${RECONNECT_DELAY / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
      );
      setTimeout(connectToPumpPortal, RECONNECT_DELAY);
    } else {
      console.error('[PumpPortal] Max reconnection attempts reached');
    }
  });

  ws.on('error', (err) => {
    console.error('[PumpPortal] WebSocket error:', err.message);
  });
}

// Also fetch from Moralis API as backup
async function fetchFromMoralis() {
  try {
    const response = await fetch(
      'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new',
      {
        headers: {
          'X-API-Key': process.env.MORALIS_API_KEY || '',
        },
      }
    );

    if (!response.ok) return;

    const data = (await response.json()) as { result?: Array<Record<string, unknown>> };
    if (data.result && Array.isArray(data.result)) {
      for (const item of data.result.slice(0, 30)) {
        const token: Token = {
          address: (item.tokenAddress || item.address) as string,
          symbol: (item.symbol || 'UNKNOWN') as string,
          name: (item.name || 'Unknown') as string,
          logo: (item.logo || item.image) as string | undefined,
          price: parseFloat(String(item.priceUsd || item.price || '0')),
          marketCap: parseFloat(String(item.marketCapUsd || item.marketCap || '0')),
          createdAt: (item.createdAt as string) || new Date().toISOString(),
          fetchedAt: Date.now(),
        };
        addToken(token);
      }
      console.log(`[Moralis] Fetched ${data.result.length} tokens`);
    }
  } catch (err) {
    console.error('[Moralis] Fetch failed:', err);
  }
}

// API Routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    wsConnected: ws?.readyState === WebSocket.OPEN,
    tokenCount: tokens.length,
  });
});

app.get('/api/pulse/tokens', (req, res) => {
  // Clean up old tokens before returning
  cleanupOldTokens();

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  res.json({
    tokens: tokens.slice(0, limit),
    count: tokens.length,
    wsConnected: ws?.readyState === WebSocket.OPEN,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);

  // Connect to PumpPortal WebSocket
  connectToPumpPortal();

  // Also do initial fetch from Moralis
  fetchFromMoralis();

  // Periodically fetch from Moralis as backup (every 30 seconds)
  setInterval(fetchFromMoralis, 30000);

  // Cleanup old tokens every minute
  setInterval(cleanupOldTokens, 60000);
});
