// team.js
// Multi-agent coordinator: assignments, regions, anti-collision reservations, and hand-offs.

import { manhattanDistance } from '../utils/utils.js';

const SLOT_MS = 180; // ~one movement tick; tune to server tick
const resKey = (x, y, slot) => `${Math.round(x)},${Math.round(y)},${slot}`;

function pathLen(pf, sx, sy, tx, ty) {
  if (!pf) return Infinity;
  try {
    // Try common signatures
    let path = null;
    if (typeof pf.findPath === 'function') {
      try { path = pf.findPath({ x: sx, y: sy }, { x: tx, y: ty }); }
      catch { path = pf.findPath(sx, sy, tx, ty); }
    } else if (typeof pf.shortestPath === 'function') {
      path = pf.shortestPath({ x: sx, y: sy }, { x: tx, y: ty });
    }
    if (!path) return Infinity;
    // Accept: Array of points, or object with .path
    const arr = Array.isArray(path) ? path : (Array.isArray(path.path) ? path.path : null);
    if (!arr || arr.length === 0) return Infinity;
    return Math.max(0, arr.length - 1);
  } catch {
    return Infinity;
  }
}

export class TeamCoordinator {
  constructor() {
    this.env = null;

    // id -> { id, name, x, y, regionIdx, lastSeen }
    this.agents = new Map();

    // parcelId -> agentId
    this.claims = new Map();

    // movement reservation table: `${x},${y},slot` -> agentId
    this.resTable = new Map();

    // regions: [{ spawners:[{x,y}], bbox:{minX,maxX,minY,maxY} }]
    this.regions = [];

    // parcelId -> { carrierId, receiverId, meeting:{x,y} }
    this.handoffs = new Map();
  }

  // ---------- Environment & agents ----------

  setEnv(env) {
    this.env = env || null;
    this._rebuildRegions();
  }

  registerAgent(id, name = 'agent') {
    if (!this.agents.has(id)) {
      this.agents.set(id, { id, name, x: 0, y: 0, regionIdx: 0, lastSeen: Date.now() });
      this._assignRegions();
    }
  }

  updateAgentPos(id, x, y) {
    const a = this.agents.get(id) || { id, name: `A#${id}`, regionIdx: 0 };
    a.x = Math.round(x);
    a.y = Math.round(y);
    a.lastSeen = Date.now();
    this.agents.set(id, a);
  }

  // ---------- Reservations (anti-collision) ----------

  _slotNow() { return Math.floor(Date.now() / SLOT_MS); }

  _purgeOldReservations(keepFromSlot) {
    for (const [k] of this.resTable) {
      const slot = Number(k.split(',')[2] || 0);
      if (slot < keepFromSlot - 2) this.resTable.delete(k);
    }
  }

  async reserveMove(agentId, from, to) {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    let attempts = 0;

    while (attempts++ < 20) {
      const slot = this._slotNow() + 1;
      this._purgeOldReservations(slot);

      const targetKey = resKey(to.x, to.y, slot);
      const occupiedBy = this.resTable.get(targetKey);

      // detect head-on swap
      const swapper = Array.from(this.resTable.entries()).find(([k, aid]) => {
        if (aid === agentId) return false;
        if (!k.endsWith(`,${slot}`)) return false;
        const [ox, oy] = k.split(',').slice(0, 2).map(Number);
        const other = this.agents.get(aid);
        return other && other.x === to.x && other.y === to.y && ox === from.x && oy === from.y;
      });

      if (!occupiedBy && !swapper) {
        this.resTable.set(targetKey, agentId);
        return;
      }

      await wait(35);
    }
  }

  // ---------- Regions ----------

  _rebuildRegions() {
    this.regions = [];
    if (!this.env) return;

    const sp = Array.isArray(this.env.spawnerTiles) ? this.env.spawnerTiles.slice() : [];
    const K = Math.max(1, this.agents.size || 1);

    if (sp.length === 0) {
      for (let i = 0; i < K; i++) {
        this.regions.push({
          spawners: [],
          bbox: {
            minX: Math.floor((i * this.env.width) / K),
            maxX: Math.floor(((i + 1) * this.env.width) / K) - 1,
            minY: 0,
            maxY: this.env.height - 1
          }
        });
      }
      this._assignRegions();
      return;
    }

    sp.sort((a, b) => a.x - b.x);
    const buckets = Array.from({ length: K }, () => []);
    sp.forEach((t, i) => buckets[i % K].push({ x: t.x, y: t.y }));

    this.regions = buckets.map(tiles => {
      const xs = tiles.map(t => t.x), ys = tiles.map(t => t.y);
      const bbox = tiles.length
        ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
        : { minX: 0, maxX: this.env.width - 1, minY: 0, maxY: this.env.height - 1 };
      return { spawners: tiles, bbox };
    });

    this._assignRegions();
  }

  _assignRegions() {
    if (this.regions.length === 0) return;
    const ids = [...this.agents.keys()].sort();
    ids.forEach((id, i) => {
      const a = this.agents.get(id);
      a.regionIdx = i % this.regions.length;
      this.agents.set(id, a);
    });
  }

  getRegionFor(agentId) {
    const a = this.agents.get(agentId);
    if (!a || this.regions.length === 0) return null;
    return this.regions[Math.min(a.regionIdx, this.regions.length - 1)];
  }

  // ---------- Parcel assignment ----------

  releaseClaim(parcelId, byAgentId = null) {
    if (!this.claims.has(parcelId)) return;
    if (byAgentId && this.claims.get(parcelId) !== byAgentId) return;
    this.claims.delete(parcelId);
  }

  assignBestParcel(agentId, belief) {
    const pool =
      (belief.getAvailableParcels?.() || Array.from(belief.parcels?.values?.() || []))
        .filter(p => p && !p.carriedBy && !this.claims.has(p.id));

    if (pool.length === 0) return null;

    const meReg = this.agents.get(agentId);
    const me = meReg
      ? { x: meReg.x, y: meReg.y }
      : { x: Math.round(belief?.me?.x || 0), y: Math.round(belief?.me?.y || 0) };

    let best = null, bestScore = Infinity;
    for (const p of pool) {
      const d = manhattanDistance(me.x, me.y, Math.round(p.x), Math.round(p.y));
      const score = d - (p.reward || 0) * 0.02;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best) this.claims.set(best.id, agentId);
    return best;
  }

  // ---------- Handoffs with path-based checks ----------

  /**
   * Suggest a pass-the-parcel using REACHABILITY + COST:
   *  - If carrier has NO PATH but teammate DOES -> handoff.
   *  - If teammate path is much shorter: abs >= 3 steps OR ratio <= 0.75 -> handoff.
   *  - If expected reward after decay along carrier path <= 0 but teammate's > 0 -> handoff.
   */
  recommendHandoff(belief, pathfinding) {
    const meId = belief?.me?.id;
    if (meId == null) return null;

    const me = this.agents.get(meId) || {
      x: Math.round(belief?.me?.x || 0),
      y: Math.round(belief?.me?.y || 0)
    };

    const carried = belief?.me?.carriedParcels || [];
    if (carried.length === 0) return null;
    const parcel = carried[0];

    const del = this.env?.getClosestDeliveryTile?.(me.x, me.y);
    if (!del) return null;

    const myLen = pathLen(pathfinding, me.x, me.y, del.x, del.y);
    const decay = belief.config?.LOSS_PER_MOVEMENT ?? 0.01;
    const myRewardAfter = (parcel.reward ?? 0) - decay * (isFinite(myLen) ? myLen : 9999);

    let best = null;
    for (const [id, other] of this.agents) {
      if (id === meId) continue;
      const oLen = pathLen(pathfinding, other.x, other.y, del.x, del.y);
      const oRewardAfter = (parcel.reward ?? 0) - decay * (isFinite(oLen) ? oLen : 9999);

      const unreachableWin = !isFinite(myLen) && isFinite(oLen);
      const bigAbsoluteWin = isFinite(myLen) && isFinite(oLen) && (myLen - oLen >= 3);
      const bigRelativeWin = isFinite(myLen) && isFinite(oLen) && (oLen <= Math.floor(0.75 * myLen));
      const rewardWin = (myRewardAfter <= 0 && oRewardAfter > 0);

      if (unreachableWin || bigAbsoluteWin || bigRelativeWin || rewardWin) {
        // Meet at receiver's current tile; handshake plan will free it
        best = { carrierId: meId, receiverId: id, parcelId: parcel.id, meeting: { x: other.x, y: other.y } };
        break;
      }
    }
    return best;
  }

  bookHandoff(info) { if (info?.parcelId) this.handoffs.set(info.parcelId, info); }
  clearHandoff(parcelId) { this.handoffs.delete(parcelId); }

  getHandoffForAgent(agentId) {
    for (const [pid, h] of this.handoffs) {
      if (h.carrierId === agentId || h.receiverId === agentId) return { parcelId: pid, ...h };
    }
    return null;
  }
}

export const Team = new TeamCoordinator();
