// plans.js
import { Plan } from './plan.js';
import { manhattanDistance } from '../utils/utils.js';

export class PickUpPlan extends Plan {
    constructor(client, belief, pathfinding, parcel) {
        super(client, belief, pathfinding);
        this.parcel = parcel;
    }

    async execute() {
        console.log(`Executing PickUp plan for parcel ${this.parcel.id} at (${this.parcel.x}, ${this.parcel.y})`);

        // Check if parcel still exists and is available
        const currentParcel = this.belief.getParcel(this.parcel.id);
        if (!currentParcel || currentParcel.carriedBy) {
            console.log(`Parcel ${this.parcel.id} is no longer available`);
            return false;
        }

        // Move to parcel location
        const success = await this.moveTo(Math.round(this.parcel.x), Math.round(this.parcel.y));

        if (!success || this.stopped) {
            console.log(`Failed to reach parcel ${this.parcel.id}`);
            // Record failed attempt
            this.belief.recordFailedAttempt(this.parcel.id);
            return false;
        }

        try {
            // Pick up the parcels (returns array of picked up parcel IDs)
            const pickedUpParcels = await this.client.emitPickup();
            console.log(`Picked up ${pickedUpParcels.length} parcel(s):`, pickedUpParcels.map(p => p.id));
            
            // Clear failed attempts on success
            this.belief.clearFailedAttempt(this.parcel.id);
            
            return true;
        } catch (error) {
            console.error('Failed to pickup parcel:', error);
            this.belief.recordFailedAttempt(this.parcel.id);
            return false;
        }
    }
}

export class DeliverPlan extends Plan {
    constructor(client, belief, pathfinding) {
        super(client, belief, pathfinding);
    }

    async execute() {
        console.log('Executing Deliver plan');

        if (this.belief.me.carriedParcels.length === 0) {
            console.log('No parcels to deliver');
            return false;
        }

        const closestDelivery = this.belief.environment.getClosestDeliveryTile(
            Math.round(this.belief.me.x),
            Math.round(this.belief.me.y)
        );

        if (!closestDelivery) {
            console.log('No delivery zone found');
            return false;
        }

        console.log(`Moving to delivery zone at (${closestDelivery.x}, ${closestDelivery.y})`);

        const success = await this.moveTo(closestDelivery.x, closestDelivery.y);

        if (!success || this.stopped) {
            console.log('Failed to reach delivery zone');
            return false;
        }

        try {
            const droppedParcels = await this.client.emitPutdown();
            console.log(`Delivered ${droppedParcels.length} parcel(s):`, droppedParcels.map(p => p.id));
            
            // Remove delivered parcels from belief
            for (const droppedParcel of droppedParcels) {
                this.belief.parcels.delete(droppedParcel.id);
            }
            
            this.belief.me.carriedParcels = [];
            
            return true;
        } 
        catch (error) {
            console.error('Failed to deliver parcels:', error);
            return false;
        }
    }
}

export class RandomPlan extends Plan {
    constructor(client, belief, pathfinding) {
        super(client, belief, pathfinding);
    }

    async execute() {
        console.log('Executing Random plan - exploring');
        const targetTile = this.getRandomReachableTile();
        if (!targetTile) {
            console.log('No random tile found');
            return false;
        }
        console.log(`Random exploration to (${targetTile.x}, ${targetTile.y})`);
        const success = await this.moveTo(targetTile.x, targetTile.y);
        return success && !this.stopped;
    }

    getRandomReachableTile() {
        const env = this.belief.environment;
        const currentX = Math.round(this.belief.me.x);
        const currentY = Math.round(this.belief.me.y);

        // 35% chance: far jump across the map to break local orbits
        const farJump = Math.random() < 0.35;
        if (farJump) {
            for (let tries = 0; tries < 300; tries++) {
                const x = Math.floor(Math.random() * env.width);
                const y = Math.floor(Math.random() * env.height);
                if ((x !== currentX || y !== currentY) && env.isReachable(x, y)) return { x, y };
            }
        }

        // Otherwise do a local hop within a wider radius
        const maxRange = 12;
        const picks = [];
        for (let y = Math.max(0, currentY - maxRange); y <= Math.min(env.height - 1, currentY + maxRange); y++) {
            for (let x = Math.max(0, currentX - maxRange); x <= Math.min(env.width - 1, currentX + maxRange); x++) {
                if ((x !== currentX || y !== currentY) && env.isReachable(x, y)) {
                    const d = Math.abs(x - currentX) + Math.abs(y - currentY);
                    if (d > 0 && d <= maxRange) picks.push({ x, y });
                }
            }
        }
        if (picks.length) return picks[Math.floor(Math.random() * picks.length)];

        // Last resort: global probe
        for (let tries = 0; tries < 300; tries++) {
            const x = Math.floor(Math.random() * env.width);
            const y = Math.floor(Math.random() * env.height);
            if ((x !== currentX || y !== currentY) && env.isReachable(x, y)) return { x, y };
        }
        return null;
    }

    shouldPreempt() {
        if (this.belief.shouldDeliver()) return true;
        const best = this.belief.getBestParcel();
        return !!best;
    }

}
export class ExplorePlan extends Plan {
    // ---- Tunables ----
    static ROUTE_MAX_WAYPOINTS = 6;     // visit up to K spawners per explore run
    static FAR_BONUS_DIST = 20;         // prefer far, unvisited spawners a bit more
    static RECENCY_COOLDOWN_MS = 45_000; // treat spawner "fresh" for this long
    static SKIP_IF_ALREADY_HERE = true; // don't pick current tile

    // Track per-spawner recency: 'x,y' -> lastVisitedMs
    static visitedAt = new Map();

    constructor(client, belief, pathfinding) {
        super(client, belief, pathfinding);
    }

    // Yield if there is something better to do now
    shouldPreempt() {
        if (this.belief.shouldDeliver()) return true;
        const best = this.belief.getBestParcel?.();
        return !!best;
    }

    async execute() {
        console.log('Executing Explore plan — spawner sweep');

        const env = this.belief.environment;
        const spawners = env.spawnerTiles || [];
        if (!spawners.length) {
            console.log('No spawner tiles → cannot run ExplorePlan.');
            return false;
        }

        const meX = Math.round(this.belief.me.x);
        const meY = Math.round(this.belief.me.y);

        // Build a small route of spawners to visit
        const route = this.buildSpawnerRoute(meX, meY, spawners, env);

        if (!route.length) {
            console.log('No viable spawner route → fallback to RandomPlan.');
            const rnd = new RandomPlan(this.client, this.belief, this.pathfinding);
            return await rnd.execute();
        }

        // Walk the route (yield between waypoints for pickup/deliver)
        for (const wp of route) {
            if (this.shouldPreempt()) {
                console.log('Explore preempted by higher-priority goal.');
                this.stop();
                return false;
            }

            const ok = await this.moveTo(Math.round(wp.x), Math.round(wp.y));
            if (!ok || this.stopped) {
                console.log(`Could not reach spawner (${wp.x}, ${wp.y}), skipping.`);
                continue;
            }

            // Mark as visited
            ExplorePlan.visitedAt.set(`${wp.x},${wp.y}`, Date.now());
            // tiny pause to sense freshly-spawned parcels
            await new Promise(r => setTimeout(r, 50));
        }

        return true;
    }

    buildSpawnerRoute(meX, meY, spawners, env) {
        const now = Date.now();

        // Filter to reachable tiles and (optionally) not current tile
        let candidates = spawners.filter(s => {
            if (ExplorePlan.SKIP_IF_ALREADY_HERE && s.x === meX && s.y === meY) return false;
            return env.isReachable(s.x, s.y);
        });

        if (!candidates.length) return [];

        // Score: prefer (1) never/long-ago visited, (2) farther ones slightly (to break local loops), (3) closer from current
        const baseScore = (s) => {
            const key = `${s.x},${s.y}`;
            const last = ExplorePlan.visitedAt.get(key) || 0;
            const ageMs = now - last;
            const distFromMe = Math.abs(s.x - meX) + Math.abs(s.y - meY);
            const farBonus = Math.max(0, distFromMe - ExplorePlan.FAR_BONUS_DIST);

            // Lower is better
            // Put very old/unvisited first (negative offset), break ties by distance from me
            const recencyTerm = last ? Math.floor(last / 1000) : 0; // smaller when unseen
            return recencyTerm - farBonus + distFromMe * 0.01;
        };

        // Start from the best seed spawner
        candidates.sort((a, b) => baseScore(a) - baseScore(b));
        const route = [];
        let curr = { x: meX, y: meY };
        let remaining = candidates.slice();

        // Greedy nearest-neighbor sweep for up to K waypoints
        while (route.length < ExplorePlan.ROUTE_MAX_WAYPOINTS && remaining.length) {
            // pick nearest from current among the first N best baseScore to bias toward stale spawners
            const pool = remaining.slice(0, Math.min(10, remaining.length));
            let best = null, bestD = Infinity, bestIdx = -1;

            for (let i = 0; i < pool.length; i++) {
                const s = pool[i];
                const d = Math.abs(s.x - curr.x) + Math.abs(s.y - curr.y);
                if (d < bestD) { bestD = d; best = s; bestIdx = i; }
            }

            if (!best) break;

            route.push(best);
            curr = best;

            // remove chosen from remaining
            const rmKey = `${best.x},${best.y}`;
            remaining = remaining.filter(s => `${s.x},${s.y}` !== rmKey);
        }

        console.log(`Spawner route length: ${route.length}`, route.map(p => `(${p.x},${p.y})`).join(' -> '));
        return route;
    }
}
