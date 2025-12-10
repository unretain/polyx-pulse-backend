# Polyx Pulse Backend

Real-time pump.fun token collector for the Polyx mobile app.

## What it does

- Connects to PumpPortal WebSocket 24/7
- Collects new token launches in real-time
- Keeps last 5 minutes of tokens in memory
- Exposes REST API for mobile app

## API Endpoints

- `GET /health` - Server health check
- `GET /api/pulse/tokens?limit=50` - Get recent tokens

## Deploy to Railway

1. Click the button below
2. Wait for deploy
3. Copy the URL and update your mobile app config

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/polyx-pulse)

## Manual Deploy

```bash
npm install
npm start
```

## Environment Variables

None required - uses free PumpPortal WebSocket.

Optional:
- `PORT` - Server port (default: 3001)
- `MORALIS_API_KEY` - For backup token fetching
