// plans_coop.js
import { Plan } from '../intentions/plan.js';
import { Team } from './team.js';

const dirs4 = [
  {dx: 0, dy: 1}, {dx: 0, dy: -1}, {dx: 1, dy: 0}, {dx: -1, dy: 0}
];
const add = (a,b)=>({x:a.x+b.dx,y:a.y+b.dy});

function neighbors4(env, x, y) {
  const res = [];
  for (const d of dirs4) {
    const nx = x + d.dx, ny = y + d.dy;
    if (env.isReachable(nx, ny)) res.push({x:nx, y:ny});
  }
  return res;
}

// Patrol spawners within assigned region
export class ExploreCoopPlan extends Plan {
  constructor(client, belief, pathfinding, region) {
    super(client, belief, pathfinding);
    this.region = region;
  }
  shouldPreempt() {
    return (this.belief.shouldDeliver?.() === true) ||
           ((this.belief.getAvailableParcels?.() || []).length > 0);
  }
  _route() {
    const meX = Math.round(this.belief.me.x), meY = Math.round(this.belief.me.y);
    const sp = (this.region?.spawners || []).slice();
    if (!sp.length) {
      const b = this.region?.bbox || {minX:0, minY:0, maxX:this.belief.environment.width-1, maxY:this.belief.environment.height-1};
      const corners = [{x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}];
      corners.sort((a,b2)=>Math.abs(a.x-meX)+Math.abs(a.y-meY)-Math.abs(b2.x-meX)-Math.abs(b2.y-meY));
      return corners;
    }
    const route = [];
    let curr = {x:meX,y:meY}, remaining = sp.slice();
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      for (let i=0;i<remaining.length;i++){
        const t = remaining[i]; const d = Math.abs(curr.x-t.x)+Math.abs(curr.y-t.y);
        if (d < bd) { bd = d; bi = i; }
      }
      route.push(remaining[bi]); curr = remaining[bi]; remaining.splice(bi,1);
    }
    return route;
  }
  async execute() {
    const route = this._route();
    for (const p of route) {
      if (this.stopped) break;
      const ok = await this.moveTo(p.x, p.y);
      if (!ok || this.stopped) break;
      await new Promise(r => setTimeout(r, 60));
      if (this.shouldPreempt()) { this.stop(); return true; }
    }
    return true;
  }
}

// Coordinated pass-the-parcel (3-phase handshake).
export class HandoffPlan extends Plan {
  constructor(client, belief, pathfinding, info /* {carrierId,receiverId,parcelId,meeting:{x,y}} */) {
    super(client, belief, pathfinding);
    this.info = info;
  }

  _carrierNearMeeting() {
    const me = this.belief.me;
    const dx = Math.abs(Math.round(me.x) - this.info.meeting.x);
    const dy = Math.abs(Math.round(me.y) - this.info.meeting.y);
    return (dx + dy) === 1;
  }

  _findReceiver() {
    for (const a of this.belief.agents.values?.() || []) {
      if (a.id === this.info.receiverId) return a;
    }
    return null;
  }

  _parcelOn(x,y) {
    const p = this.belief.parcels?.get?.(this.info.parcelId);
    return p && Math.round(p.x) === x && Math.round(p.y) === y && !p.carriedBy;
  }

  async execute() {
    const meId = this.belief.me.id;
    const isCarrier  = meId === this.info.carrierId;
    const isReceiver = meId === this.info.receiverId;
    const meet = this.info.meeting;

    if (isReceiver) {
      // 1) Go to meeting tile and wait until carrier arrives adjacent
      if (!await this.moveTo(meet.x, meet.y)) return false;

      // loop: either the parcel appears on meeting tile, or carrier arrives adjacent
      let tries = 40;
      while (!this.stopped && tries-- > 0) {
        if (this._parcelOn(meet.x, meet.y)) {
          const picked = await this.client.emitPickup();
          if (Array.isArray(picked) ? picked.some(p => p.id === this.info.parcelId) : true) {
            Team.clearHandoff(this.info.parcelId);
            return true;
          }
        }

        // Carrier adjacent? Step aside to free the tile, then step back to pick.
        const carrierNear = [...(this.belief.agents?.values?.() || [])]
          .some(a => a.id === this.info.carrierId && (Math.abs(Math.round(a.x)-meet.x)+Math.abs(Math.round(a.y)-meet.y)===1));
        if (carrierNear) {
          // move to any reachable neighbor (not into the carrier)
          const nbs = neighbors4(this.belief.environment, meet.x, meet.y);
          for (const n of nbs) {
            const ok = await this.moveTo(n.x, n.y);
            if (ok) break;
          }

          // wait for drop, then return and pick
          let wait = 20;
          while (wait-- > 0 && !this._parcelOn(meet.x, meet.y)) {
            await new Promise(r => setTimeout(r, 80));
          }
          await this.moveTo(meet.x, meet.y);
          const picked = await this.client.emitPickup();
          if (Array.isArray(picked) ? picked.some(p => p.id === this.info.parcelId) : true) {
            Team.clearHandoff(this.info.parcelId);
            return true;
          }
        }

        await new Promise(r => setTimeout(r, 80));
      }
      return false;
    }

    if (isCarrier) {
      // 1) Move adjacent, then onto the meeting tile when it's free
      // First, approach the meeting tile area
      if (!this._carrierNearMeeting()) {
        const nbs = neighbors4(this.belief.environment, meet.x, meet.y);
        // choose nearest neighbor
        nbs.sort((a,b)=>Math.abs(a.x-Math.round(this.belief.me.x))+Math.abs(a.y-Math.round(this.belief.me.y))
                       - (Math.abs(b.x-Math.round(this.belief.me.x))+Math.abs(b.y-Math.round(this.belief.me.y))));
        for (const n of nbs) {
          if (await this.moveTo(n.x, n.y)) break;
        }
      }

      // 2) Try to step onto the meeting tile (receiver should step aside)
      let enterTries = 20;
      while (!this.stopped && enterTries-- > 0) {
        const rx = meet.x, ry = meet.y;
        const ok = await this.moveTo(rx, ry);
        if (ok) break;
        await new Promise(r => setTimeout(r, 80));
      }

      // 3) Drop on meeting tile
      let dropTries = 10;
      while (!this.stopped && dropTries-- > 0) {
        await this.client.emitPutdown();
        await new Promise(r => setTimeout(r, 80));

        const stillCarrying = (this.belief.me?.carriedParcels || []).some(p => p.id === this.info.parcelId);
        if (!stillCarrying) {
          Team.clearHandoff(this.info.parcelId);
          return true;
        }
      }
      return false;
    }

    return false;
  }
}
