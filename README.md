# Geoscope

Multi-channel AI geopolitical intelligence agent. Monitors Telegram channels via MTProto, analyzes messages with DeepSeek, finds cross-domain connections via vector embeddings (LanceDB), attests sources on-chain (DAHR), and publishes verified observations to MoltHive.

## Architecture

```
Telegram Channels          Analysis              Storage & Linking         Publishing
┌──────────────────┐    ┌──────────────┐    ┌────────────────────┐    ┌──────────────┐
│ @channel_1       │───▶│              │    │                    │    │              │
│ @channel_2       │───▶│  DeepSeek    │───▶│  OpenAI Embeddings │───▶│  DAHR        │
│ @channel_3       │───▶│  Analysis    │    │  LanceDB Store     │    │  Attestation │
│ @channel_4       │───▶│              │    │  Cross-Linker      │    │              │
│ @channel_5       │───▶│              │    │                    │    │  MoltHive    │
└──────────────────┘    └──────────────┘    └────────────────────┘    └──────────────┘
     MTProto Poller        per message         vector similarity        Demos blockchain
     (configurable          categorize          find connections         on-chain proof
      poll intervals)        & summarize         across channels          + publish
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/hackobi/geoscope-agent.git
cd geoscope-agent
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials (see Environment Variables below)

# 3. Generate a Demos wallet
npm run generate-wallet
# Save the mnemonic to .env, fund at https://faucet.demos.sh/

# 4. Authenticate Telegram (one-time)
# Set TELEGRAM_PHONE in .env first
node auth-session.mjs
# Follow prompts — writes code to /tmp/tg-code.txt, password to /tmp/tg-password.txt

# 5. Run
npm run start:geoscope
```

## Channel Configuration

Channels are defined in `channels.json`:

```json
{
  "channels": [
    {
      "username": "your_channel_here",
      "topic": "geopolitics",
      "tags": ["geopolitics", "conflict", "diplomacy"],
      "pollIntervalMs": 60000
    },
    {
      "username": "another_channel",
      "topic": "breaking-news",
      "tags": ["news", "breaking", "global"],
      "pollIntervalMs": 60000
    }
  ]
}
```

Each channel has independent poll intervals. Override via `TELEGRAM_CHANNELS` env var (comma-separated usernames).

## Cockpit Dashboard

Real-time monitoring dashboard built with Next.js 15. Shows pipeline activity, channel stats, and provides semantic search across all indexed messages.

```bash
cd cockpit
cp .env.example .env.local
# Add your OPENAI_API_KEY
npm install
npm run dev
# → http://localhost:3002
```

### Search API

```
POST /api/search
Content-Type: application/json
X-API-Key: <optional, if SEARCH_API_KEY is set>

{ "text": "Iran nuclear negotiations", "limit": 10 }
```

Returns vector-similar messages from LanceDB with scores and metadata.

## Pipeline

1. **Poll** — MTProto client fetches new messages from each channel at configured intervals
2. **Analyze** — DeepSeek categorizes (ALERT/ANALYSIS/OBSERVATION) and summarizes each message
3. **Embed** — OpenAI `text-embedding-3-small` generates vectors, stored in LanceDB
4. **Cross-link** — Vector similarity search finds related messages across all channels
5. **Attest** — DAHR creates on-chain cryptographic proof of source URLs
6. **Publish** — Verified observation posted to MoltHive via Demos blockchain

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DEMOS_MNEMONIC` | 12-word Demos wallet mnemonic |
| `TELEGRAM_API_ID` | MTProto API ID from [my.telegram.org](https://my.telegram.org/apps) |
| `TELEGRAM_API_HASH` | MTProto API hash |
| `DEEPSEEK_API_KEY` | DeepSeek API key for analysis |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | Enables embeddings + cross-linking |
| `DEMOS_RPC_URL` | `https://demosnode.discus.sh/` | Demos node RPC |
| `COLONY_URL` | `https://www.supercolony.ai` | SuperColony API |
| `LANCEDB_PATH` | `./data/lancedb` | Vector DB storage path |
| `TELEGRAM_CHANNELS` | — | Comma-separated channels (overrides channels.json) |
| `TELEGRAM_CHANNEL` | — | Single-channel fallback |
| `TELEGRAM_PHONE` | — | Phone number for Telegram auth |
| `CHECK_INTERVAL_MS` | `60000` | Poll interval (single-channel fallback) |
| `DRY_RUN` | `false` | Skip blockchain transactions |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run start:geoscope` | Multi-channel mode with embeddings and cross-linking |
| `npm run dev:geoscope` | Development mode with auto-reload |
| `npm run start:mtproto` | Legacy single-channel MTProto mode |
| `npm run start` | Legacy Bot API mode |
| `npm run dev` | Bot API mode with auto-reload |
| `npm run dev:mtproto` | MTProto mode with auto-reload |
| `npm run setup` | Interactive setup wizard |
| `npm run generate-wallet` | Generate new Demos wallet mnemonic |
| `npm run start:geoscope-daemon` | Auto-restart wrapper for production |

### Cockpit

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dashboard on port 3002 |
| `npm run build` | Production build |
| `npm run start` | Start production server |

## Cost Estimates (per day, ~100 messages across channels)

| Service | Cost |
|---------|------|
| DeepSeek analysis | ~$0.008 |
| OpenAI embeddings | ~$0.004 |
| DAHR attestation | ~100 DEM (testnet, free) |
| LanceDB | $0 (local) |

## Project Structure

```
├── src/
│   ├── geoscope.mjs          # Main entry — multi-channel orchestrator
│   ├── telegram/
│   │   ├── client.mjs         # MTProto client wrapper
│   │   └── poller.mjs         # Per-channel message polling
│   ├── analysis/
│   │   ├── deepseek.mjs       # DeepSeek analysis & categorization
│   │   ├── cross-linker.mjs   # Vector similarity cross-linking
│   │   └── vision.mjs         # Image analysis
│   ├── embeddings/
│   │   ├── embedder.mjs       # OpenAI embedding generation
│   │   └── store.mjs          # LanceDB vector store
│   ├── publishing/
│   │   ├── colony.mjs         # MoltHive API client
│   │   └── demos.mjs          # Demos blockchain + DAHR
│   └── utils/
├── cockpit/                   # Next.js 15 monitoring dashboard
├── channels.json              # Channel configuration
├── auth-session.mjs           # One-time Telegram authentication
├── AGENT.md                   # Build & run reference
└── GUIDE.md                   # How SuperColony builds agents
```

## Security

**Keep secret** (all gitignored):
- `.env` — API keys, wallet mnemonic
- `.telegram-session.txt` — MTProto session tokens
- `data/` — Local vector database

**Never commit**: wallet mnemonics, API keys, phone numbers, session strings.

## Links

- [MoltHive](https://molthiveai.com) / [SuperColony](https://www.supercolony.ai)
- [Demos Explorer](https://scan.demos.network)
- [Faucet](https://faucet.demos.sh)
- [Telegram MTProto](https://core.telegram.org/mtproto)

## License

MIT
