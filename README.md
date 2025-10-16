# Deliveroo BDI Agents

Autonomous agent(s) for the **Deliveroo.js** simulation built with the **Belief–Desire–Intention (BDI)** model.  
The agents perceive the world, update beliefs, form goals, plan actions, and continuously adapt to dynamic conditions.  
Supports both **single-agent** play and **cooperative** strategies (handover/teaming, traffic awareness).

> Built for the Unitn ASA _Deliveroo_ environment.

---

## ✨ Features

- **BDI architecture**: beliefs, goals, intentions, and plans separated for clarity and extensibility.
- **Exploration, pickup, delivery** plans with dynamic preemption (e.g., deliver now if reward crosses a threshold).
- **Spawner-aware / region exploration** hooks (configurable to avoid staying in the same area).
- **Cooperation** primitives (team assignments, simple handovers, traffic awareness channel).
- **Pathfinding** utilities and configurable heuristics (e.g., Manhattan/A* variants).
- **Config-first design**: tweak thresholds, detour radius, and blocked behavior without touching logic.

---

## 📁 Project Structure

```
.
├── beliefs/
│   ├── beliefs.js          # World model: entities, tiles, parcels, stations
│   ├── environment.js      # Percepts → belief updates
│   └── tile.js             # Grid/tile abstractions
├── cooperation/
│   ├── agent_coop.js       # Cooperative agent wrapper/lifecycle
│   ├── plans_coop.js       # Team plans (handover, roles)
│   ├── team.js             # Team coordinator / assignments
│   └── traffic_client.js   # Lightweight traffic/communication client
├── intentions/
│   ├── intention.js        # Intention base
│   ├── plan.js             # Plan base
│   └── plans.js            # Single-agent plans (explore, pickup, deliver)
├── utils/
│   ├── pathfinding.js      # Path search helpers (e.g., Manhattan, A*)
│   └── utils.js            # Constants, thresholds, helpers
├── agent.js                # Agent bootstrap (single)
├── config.js               # Tunables: thresholds, detours, timeouts
├── index.js                # App entrypoint
├── .env                    # Tokens / server config (not committed)
├── package.json
└── package-lock.json
```

> `node_modules/` is intentionally omitted and should be ignored via `.gitignore`.

---

## 🧰 Prerequisites

- **Node.js 18+** (LTS recommended)
- Access to a **Deliveroo.js** server (local or remote) and at least one valid agent token

---

## 🚀 Quick Start

1) **Install dependencies**
```bash
npm install
```

2) **Configure environment**
Create a `.env` file in the project root (example values below; adjust to your setup):

```bash
# .env
SERVER_URL=ws://localhost:8080
AGENT_TOKEN=PASTE_YOUR_AGENT_TOKEN
AGENT_NAME=Agent1
TEAM_TOKEN=optional-team-token
```

3) **Run**
```bash
# Start a single agent
node index.js
```

> To experiment with **cooperation**, launch multiple terminals with different `AGENT_NAME` / `AGENT_TOKEN` values, or adapt `cooperation/agent_coop.js` and `cooperation/team.js` to your scenario.
