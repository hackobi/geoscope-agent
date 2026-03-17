# Geoscope — Build & Run Reference

## Quick Start

```bash
# Install dependencies (including LanceDB)
npm install

# Run with multi-channel support
npm run start:geoscope

# Development mode (auto-restart on changes)
npm run dev:geoscope

# Dry run (no blockchain transactions)
DRY_RUN=true npm run start:geoscope
```

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DEMOS_MNEMONIC` | 12-word wallet mnemonic |
| `TELEGRAM_API_ID` | MTProto API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | MTProto API hash |
| `DEEPSEEK_API_KEY` | DeepSeek API key |

## Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | Enables embeddings + cross-linking |
| `DEMOS_RPC_URL` | `https://demosnode.discus.sh/` | Demos node |
| `COLONY_URL` | `https://www.supercolony.ai` | SuperColony API |
| `LANCEDB_PATH` | `./data/lancedb` | Vector DB storage |
| `TELEGRAM_CHANNELS` | — | Comma-separated channels (overrides channels.json) |
| `TELEGRAM_CHANNEL` | — | Single-channel fallback |
| `CHECK_INTERVAL_MS` | `60000` | Poll interval for single-channel fallback |
| `DRY_RUN` | `false` | Skip blockchain transactions |

## Entry Points

| Script | Entry | Purpose |
|--------|-------|---------|
| `start:geoscope` | `src/geoscope.mjs` | Multi-channel with embeddings |
| `start:mtproto` | `src/agent-mtproto.mjs` | Legacy single-channel |
| `start` | `src/agent.mjs` | Legacy Bot API mode |

## First-Time Setup

1. `npm run setup` — generates wallet, configures .env
2. `node auth-session.mjs` — authenticates Telegram (one-time)
3. Fund wallet at https://faucet.demos.sh/
4. Edit `channels.json` for your channels
5. `npm run start:geoscope`

## Data Files

| Path | Purpose | Gitignored |
|------|---------|------------|
| `data/lancedb/` | Vector embeddings | Yes |
| `data/poller-state.json` | Per-channel last message IDs | Yes |
| `.telegram-session.txt` | MTProto session | Yes |
| `.env` | Configuration | Yes |

## Cost Estimates (per day, ~100 msgs across all channels)

| Service | Cost |
|---------|------|
| OpenAI embeddings | ~$0.004 |
| DeepSeek analysis | ~$0.008 |
| DAHR attestation | ~100 DEM (testnet, free) |
| LanceDB | $0 (local) |
