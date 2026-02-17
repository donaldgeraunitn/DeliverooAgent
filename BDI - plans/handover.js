import { Plan } from './plan.js';
import { tileKey, manhattanDistance } from '../Utils/utils.js';

export class CollectorPlan extends Plan {
    constructor(beliefs, pathfinding, spawnTile, handoverTile, coordination) {
        super(beliefs, pathfinding, coordination);

        // “Spawn-side” role: patrol spawners, pick up parcels, bring them to the handover tile
        this.spawnTile = spawnTile;
        this.handoverTile = handoverTile;

        this.cachedGoal = null;      // key for current goal tile
        this.stagingTile = null;     // neighbor of handover preferred on spawn-side

        // Detect persistent blocking (e.g., corridor deadlock) and switch strategy
        this.stuckCounter = 0;
        this.lastPosition = null;

        console.log(`[Collector] Created with spawn (${spawnTile.x},${spawnTile.y}), handover (${handoverTile.x},${handoverTile.y})`);
    }

    getAction() {
        const pos = { x: Math.floor(this.beliefs.x), y: Math.floor(this.beliefs.y) };
        const carriedParcels = this.beliefs.getCarriedParcels();
        const hasParcel = carriedParcels.length > 0;

        if (pos.x === -1 || pos.y === -1) {
            console.log('[Collector] Invalid position, waiting...');
            return null;
        }

        // High-level policy:
        // - If carrying parcels: optionally “batch” more pickups nearby, else go to handover and drop.
        // - If empty: go collect at spawners.
        if (hasParcel) {
            const maxCapacity = this.beliefs.config.MAX_PARCELS_DETOUR;
            const hasCapacity = carriedParcels.length < maxCapacity;

            // If we still have capacity, keep collecting if there are worthwhile nearby spawns with parcels
            if (hasCapacity) {
                const nearbyParcels = this.findNearbySpawnParcels(pos);
                if (nearbyParcels.length > 0) {
                    console.log(`[Collector] Carrying ${carriedParcels.length}, collecting more (${nearbyParcels.length} nearby)`);
                    return this.goToSpawnAndPickup(pos);
                }
            }

            // Otherwise: stop collecting and head to handover
            console.log(`[Collector] Carrying ${carriedParcels.length} parcels, going to handover`);
            return this.goToHandoverAndDrop(pos);
        } 
        else {
            return this.goToSpawnAndPickup(pos);
        }
    }

    /**
     * Returns a list of { tile, parcel, dist } for spawner tiles with a visible free parcel
     * whose distance is “reasonable” compared to heading to handover now.
     */
    findNearbySpawnParcels(pos) {
        const spawnsWithParcels = this.beliefs.environment.spawnerTiles
            .map(tile => {
                // Associate each spawn with an available parcel at that exact cell (if any)
                const parcel = this.beliefs.parcels.find(
                    p => Math.floor(p.x) === tile.x &&
                        Math.floor(p.y) === tile.y &&
                        !p.carriedBy
                );

                if (!parcel) return null;

                const dist = manhattanDistance(pos.x, pos.y, tile.x, tile.y);
                return { tile, parcel, dist };
            })
            .filter(item => item !== null)
            .sort((a, b) => a.dist - b.dist);

        return spawnsWithParcels;
    }


    goToSpawnAndPickup(pos) {
        // Spawn patrol strategy:
        // - If any spawner currently has a parcel, go to the closest one.
        // - Otherwise, move to the designated spawn tile and wait.

        const spawnTilesWithParcels = this.beliefs.environment.spawnerTiles
            .map(tile => {
                const parcel = this.beliefs.parcels.find( p => Math.floor(p.x) === tile.x &&  Math.floor(p.y) === tile.y &&  !p.carriedBy );
                return parcel ? { tile, parcel } : null;
            })
            .filter(item => item !== null);

        // If already on a spawner tile, attempt immediate pickup when a parcel is present
        const currentTileIsSpawn = this.beliefs.environment.spawnerTiles.some(
            tile => tile.x === pos.x && tile.y === pos.y
        );

        if (currentTileIsSpawn) {
            const parcelHere = this.beliefs.parcels.find( p => Math.floor(p.x) === pos.x && Math.floor(p.y) === pos.y && !p.carriedBy );

            if (parcelHere) {
                console.log(`[Collector] Picking up at spawn (${pos.x}, ${pos.y})`);
                this.succeed();
                this.clearCachedGoal();
                return { action: 'pickup' };
            }
        }

        // Prefer the closest spawner tile with an available parcel (greedy by Manhattan distance)
        if (spawnTilesWithParcels.length > 0) {
            let closest = spawnTilesWithParcels[0];
            let minDist = manhattanDistance(pos.x, pos.y, closest.tile.x, closest.tile.y);

            for (const item of spawnTilesWithParcels) {
                const distance = manhattanDistance(pos.x, pos.y, item.tile.x, item.tile.y);
                if (distance < minDist) {
                    minDist = distance;
                    closest = item;
                }
            }

            console.log(`[Collector] Moving to spawn (${closest.tile.x}, ${closest.tile.y}) with parcel`);
            return this.stepToward(pos, closest.tile, 'spawn-with-parcel');
        }

        // No visible parcels at spawners: wait at the designated spawn tile to reduce reaction time
        if (pos.x === this.spawnTile.x && pos.y === this.spawnTile.y) {
            console.log('[Collector] Waiting for parcel at designated spawn');
            return null;
        }

        console.log(`[Collector] No parcels visible, moving to designated spawn (${this.spawnTile.x}, ${this.spawnTile.y})`);
        return this.stepToward(pos, this.spawnTile, 'designated-spawn');
    }

    goToHandoverAndDrop(pos) {
        // Deadlock detection: if our position does not change for too long, bypass the handover.
        const posKey = `${pos.x},${pos.y}`;
        if (this.lastPosition === posKey) {
            this.stuckCounter++;
        } 
        else {
            this.stuckCounter = 0;
            this.lastPosition = posKey;
        }

        if (this.stuckCounter >= this.beliefs.config.MAX_STUCK_TICKS) {
            console.log(`[Collector] Stuck for ${this.stuckCounter} ticks, bypassing handover and delivering directly!`);
            return this.bypassHandoverAndDeliverDirect(pos);
        }

        // If standing on the handover tile: drop only when courier is ready (adjacent) to minimize delay
        if (pos.x === this.handoverTile.x && pos.y === this.handoverTile.y) {
            if (this.isCourierReady()) {
                console.log('[Collector] Dropping at handover');
                this.succeed();
                this.clearCachedGoal();
                this.stuckCounter = 0;
                return { action: 'putdown' };
            }

            console.log('[Collector] Waiting for courier');
            return null;
        }

        // If handover tile is occupied, do not target it directly:
        // - move to an adjacent “staging” tile on the spawn-side and wait until it frees up.
        const handoverOccupied = this.beliefs.isBlocked(this.handoverTile.x, this.handoverTile.y);
        if (handoverOccupied) {
            const staging = this.getStagingTile();
            if (!staging) {
                console.log('[Collector] No staging tile, waiting...');
                return null;
            }

            if (pos.x === staging.x && pos.y === staging.y) {
                console.log('[Collector] Staging: waiting for handover tile to free');
                return null;
            }

            console.log(`[Collector] Staging near handover (${staging.x}, ${staging.y})`);
            return this.stepToward(pos, staging, 'staging');
        }

        // Normal case: move onto the handover tile
        console.log(`[Collector] Moving to handover (${this.handoverTile.x}, ${this.handoverTile.y})`);
        return this.stepToward(pos, this.handoverTile, 'handover');
    }

    /**
     * Fallback strategy for persistent blocking: ignore the handover step and deliver directly.
     */
    bypassHandoverAndDeliverDirect(pos) {
        const deliveryTile = this.getClosestDeliveryTile(pos.x, pos.y);

        if (!deliveryTile) {
            console.log('[Collector] No delivery tile found, failing...');
            this.fail("No delivery tile");
            this.stuckCounter = 0;
            return null;
        }

        if (pos.x === deliveryTile.x && pos.y === deliveryTile.y) {
            console.log('[Collector] Delivering directly (bypassed handover)');
            this.succeed();
            this.clearCachedGoal();
            this.stuckCounter = 0;
            return { action: 'putdown' };
        }

        console.log(`[Collector] Bypassing handover, going directly to delivery (${deliveryTile.x}, ${deliveryTile.y})`);
        return this.stepToward(pos, deliveryTile, 'bypass-delivery');
    }

    getStagingTile() {
        // Cache once computed: staging tile is a stable choice given spawn/handover geometry
        if (this.stagingTile) return this.stagingTile;

        const candidates = this.beliefs.environment.map[this.handoverTile.y][this.handoverTile.x].getNeighbors();
        if (candidates.length === 0) return null;

        // Choose neighbor closest to spawn (spawn-side), tie-break by stable key
        candidates.sort((a, b) => {
            const da = manhattanDistance(a.x, a.y, this.spawnTile.x, this.spawnTile.y);
            const db = manhattanDistance(b.x, b.y, this.spawnTile.x, this.spawnTile.y);
            if (da !== db) return da - db;
            return tileKey(a.x, a.y).localeCompare(tileKey(b.x, b.y));
        });

        this.stagingTile = candidates[0];
        return this.stagingTile;
    }

    isCourierReady() {
        // If no coordination/partner, allow immediate drop
        if (!this.coordination || !this.coordination.getPartnerId()) return true;

        const partner = this.beliefs.agents.find(a => a.id === this.coordination.getPartnerId());
        if (!partner) return false;

        const partnerPos = { x: Math.floor(partner.x), y: Math.floor(partner.y) };
        const dist = Math.abs(partnerPos.x - this.handoverTile.x) + Math.abs(partnerPos.y - this.handoverTile.y);

        // Consider “ready” if adjacent (or already on handover, depending on collision handling)
        return dist <= 1;
    }

    stepToward(pos, goal, goalName) {
        // Plan a path that can ignore the partner (to reduce false “blocked” paths in tight spaces)
        this.ensurePartnerIgnoredPath(pos, goal);

        // If no path exists right now, wait rather than failing (environment may unblock next tick)
        if (!this.path || this.path.length === 0) {
            console.log(`[Collector] No path to ${goalName} from (${pos.x},${pos.y}) to (${goal.x},${goal.y})`);
            console.log(`[Collector] Waiting for path to become available...`);
            this.clearCachedGoal();
            return null;
        }

        return this.followPath(pos.x, pos.y);
    }

    ensurePartnerIgnoredPath(pos, goal) {
        // Cache by goal tile key: recompute A* only when the goal changes or path is empty
        const goalK = tileKey(goal.x, goal.y);
        const partnerId = this.coordination ? this.coordination.getPartnerId() : null;
        const options = partnerId ? { ignoreAgentIds: new Set([partnerId]) } : null;

        if (this.cachedGoal === goalK && this.path && this.path.length > 0) return;

        this.cachedGoal = goalK;
        this.path = this.pathfinding.AStar(pos.x, pos.y, goal.x, goal.y, options);

        if (!this.path || this.path.length === 0) {
            console.log(`[Collector] A* returned empty path from (${pos.x},${pos.y}) to (${goal.x},${goal.y})`);
        }
    }

    clearCachedGoal() {
        this.cachedGoal = null;
    }

    isCompleted() {
        return false;
    }
}

/**
 * CourierPlan:
 * - Wait near the handover (delivery-side neighbor).
 * - When a parcel appears on the handover tile, move in and pick it up.
 * - Then deliver it to a delivery tile.
 */
export class CourierPlan extends Plan {
    constructor(beliefs, pathfinding, deliveryTile, handoverTile, coordination) {
        super(beliefs, pathfinding, coordination);

        this.deliveryTile = deliveryTile;
        this.handoverTile = handoverTile;

        // Cached “waiting position” next to the handover, chosen on the delivery-side
        this.waitingTile = null;
        this.cachedGoal = null;

        console.log(`[CourierPlan] Created with delivery (${deliveryTile.x},${deliveryTile.y}), handover (${handoverTile.x},${handoverTile.y})`);
    }

    getAction() {
        const pos = { x: Math.floor(this.beliefs.x), y: Math.floor(this.beliefs.y) };
        const hasParcel = this.beliefs.hasParcel();

        if (pos.x === -1 || pos.y === -1) {
            console.log('[Courier] Invalid position, waiting...');
            return null;
        }

        // Parcel is considered “ready” if it is physically on the handover tile and not carried
        const parcelAtHandover = this.beliefs.parcels.find(p => p.x === this.handoverTile.x && p.y === this.handoverTile.y && !p.carriedBy );

        // If empty-handed: either pick up from handover (if ready) or wait nearby
        if (!hasParcel) {
            if (parcelAtHandover) {
                return this.pickupFromHandover(pos);
            }
            return this.waitNearHandover(pos);
        }

        // If carrying: deliver to delivery tile
        return this.deliverParcel(pos);
    }

    pickupFromHandover(pos) {
        // If handover is currently occupied by someone else, avoid targeting it directly:
        // wait on the waiting tile instead, until it becomes available.
        if (this.beliefs.isBlocked(this.handoverTile.x, this.handoverTile.y) &&
            !(pos.x === this.handoverTile.x && pos.y === this.handoverTile.y)) {
            const waitPos = this.getWaitingTile();

            if (waitPos && pos.x === waitPos.x && pos.y === waitPos.y) {
                console.log('[Courier] Parcel ready but handover occupied: waiting');
                return null;
            }
            if (waitPos) {
                console.log(`[Courier] Parcel ready but handover occupied: moving to wait (${waitPos.x}, ${waitPos.y})`);
                return this.stepToward(pos, waitPos, 'waiting');
            }

            console.log('[Courier] Parcel ready but handover occupied: waiting (no waiting tile)');
            return null;
        }

        // Once on the handover tile, execute pickup
        if (pos.x === this.handoverTile.x && pos.y === this.handoverTile.y) {
            console.log('[Courier] Picking up at handover');
            this.succeed();
            this.clearCachedGoal();
            return { action: 'pickup' };
        }

        console.log('[Courier] Moving to handover for pickup');
        return this.stepToward(pos, this.handoverTile, 'handover');
    }

    waitNearHandover(pos) {
        // Idle policy: stand on the chosen adjacent waiting tile (delivery-side)
        const waitPos = this.getWaitingTile();
        if (!waitPos) {
            console.log('[Courier] No waiting tile, waiting in place...');
            return null;
        }

        if (pos.x === waitPos.x && pos.y === waitPos.y) {
            console.log('[Courier] Waiting for parcel');
            return null;
        }

        console.log(`[Courier] Moving to waiting position (${waitPos.x}, ${waitPos.y})`);
        return this.stepToward(pos, waitPos, 'waiting');
    }

    deliverParcel(pos) {
        if (this.beliefs.environment.isDelivery(pos.x, pos.y)) {
            console.log('[Courier] Delivering');
            this.succeed();
            this.clearCachedGoal();
            return { action: 'putdown' };
        }

        console.log(`[Courier] Moving to delivery (${this.deliveryTile.x}, ${this.deliveryTile.y})`);
        return this.stepToward(pos, this.deliveryTile, 'delivery');
    }

    getWaitingTile() {
        if (this.waitingTile) return this.waitingTile;

        const candidates = this.beliefs.environment.map[this.handoverTile.y][this.handoverTile.x].getNeighbors();
        if (candidates.length === 0) return null;

        // Choose neighbor closest to delivery (delivery-side), tie-break by stable key
        candidates.sort((a, b) => {
            const da = manhattanDistance(a.x, a.y, this.deliveryTile.x, this.deliveryTile.y);
            const db = manhattanDistance(b.x, b.y, this.deliveryTile.x, this.deliveryTile.y);
            if (da !== db) return da - db;
            return tileKey(a.x, a.y).localeCompare(tileKey(b.x, b.y));
        });

        this.waitingTile = candidates[0];
        return this.waitingTile;
    }

    stepToward(pos, goal, goalName) {
        // Plan a path that can ignore the partner to avoid artificial blocks
        this.ensurePartnerIgnoredPath(pos, goal);

        // If no path right now, wait (do not fail; the corridor may unblock)
        if (!this.path || this.path.length === 0) {
            console.log(`[Courier] No path to ${goalName} from (${pos.x},${pos.y}) to (${goal.x},${goal.y})`);
            console.log(`[Courier] Waiting for path to become available...`);
            this.clearCachedGoal();
            return null;
        }

        return this.followPath(pos.x, pos.y);
    }

    ensurePartnerIgnoredPath(pos, goal) {
        const goalK = tileKey(goal.x, goal.y);
        const partnerId = this.coordination ? this.coordination.getPartnerId() : null;
        const options = partnerId ? { ignoreAgentIds: new Set([partnerId]) } : null;

        if (this.cachedGoal === goalK && this.path && this.path.length > 0) return;

        this.cachedGoal = goalK;
        this.path = this.pathfinding.AStar(pos.x, pos.y, goal.x, goal.y, options);

        if (!this.path || this.path.length === 0) {
            console.log(`[Courier] A* returned empty path from (${pos.x},${pos.y}) to (${goal.x},${goal.y})`);
        }
    }

    clearCachedGoal() {
        this.cachedGoal = null;
    }

    isCompleted() {
        return false;
    }
}
