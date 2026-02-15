import { Plan } from './plan.js';
import { tileKey, manhattanDistance } from '../Utils/utils.js';

export class CollectorPlan extends Plan {
    constructor(beliefs, pathfinding, spawnTile, handoverTile, coordination) {
        super(beliefs, pathfinding, coordination);

        this.spawnTile = spawnTile;
        this.handoverTile = handoverTile;

        this.cachedGoal = null;      // {x,y}
        this.stagingTile = null;     // spawn-side adjacent to handover
        
        // Robustness: Track blocking/stuck situations
        this.stuckCounter = 0;
        this.lastPosition = null;
        this.MAX_STUCK_TICKS = 10;  // If stuck for 10 ticks, bypass handover
        
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

        // ═══════════════════════════════════════════════════════════════════
        // BATCH COLLECTION: Collect multiple parcels before delivering
        // ═══════════════════════════════════════════════════════════════════
        
        if (hasParcel) {
            // Check if we should collect more parcels before delivering
            const maxCapacity = this.beliefs.config.MAX_PARCELS_DETOUR || 10;
            const hasCapacity = carriedParcels.length < maxCapacity;
            
            if (hasCapacity) {
                // Find nearby spawn tiles with parcels
                const nearbyParcels = this.findNearbySpawnParcels(pos);
                
                if (nearbyParcels.length > 0) {
                    // Continue collecting!
                    console.log(`[Collector] Carrying ${carriedParcels.length}, collecting more (${nearbyParcels.length} nearby)`);
                    return this.goToSpawnAndPickup(pos);
                }
            }
            
            // No more nearby parcels OR at capacity → deliver
            console.log(`[Collector] Carrying ${carriedParcels.length} parcels, going to handover`);
            return this.goToHandoverAndDrop(pos);
        } else {
            // No parcels → go collect
            return this.goToSpawnAndPickup(pos);
        }
    }
    
    /**
     * Find parcels at spawn tiles that are within reasonable distance
     * "Nearby" means closer than the handover distance (worth collecting)
     */
    findNearbySpawnParcels(pos) {
        const distanceToHandover = manhattanDistance(pos.x, pos.y, this.handoverTile.x, this.handoverTile.y);
        const NEARBY_THRESHOLD = distanceToHandover * 0.5; // Within half the handover distance
        
        const nearbySpawnsWithParcels = this.beliefs.environment.spawnerTiles
            .filter(tile => {
                const dist = manhattanDistance(pos.x, pos.y, tile.x, tile.y);
                return dist <= NEARBY_THRESHOLD;
            })
            .map(tile => {
                const parcel = this.beliefs.parcels.find(
                    p => Math.floor(p.x) === tile.x && 
                         Math.floor(p.y) === tile.y && 
                         !p.carriedBy
                );
                return parcel ? { tile, parcel, dist: manhattanDistance(pos.x, pos.y, tile.x, tile.y) } : null;
            })
            .filter(item => item !== null)
            .sort((a, b) => a.dist - b.dist); // Sort by distance
        
        return nearbySpawnsWithParcels;
    }

    goToSpawnAndPickup(pos) {
        // ═══════════════════════════════════════════════════════════════════
        // SMART SPAWN PATROL: Check ALL spawn tiles, not just the designated one
        // ═══════════════════════════════════════════════════════════════════
        
        // Find all spawn tiles that currently have parcels
        const spawnTilesWithParcels = this.beliefs.environment.spawnerTiles
            .map(tile => {
                const parcel = this.beliefs.parcels.find(
                    p => Math.floor(p.x) === tile.x && 
                         Math.floor(p.y) === tile.y && 
                         !p.carriedBy
                );
                return parcel ? { tile, parcel } : null;
            })
            .filter(item => item !== null);
        
        // If we're already on a spawn tile, check if there's a parcel here
        const currentTileIsSpawn = this.beliefs.environment.spawnerTiles.some(
            tile => tile.x === pos.x && tile.y === pos.y
        );
        
        if (currentTileIsSpawn) {
            const parcelHere = this.beliefs.parcels.find(
                p => Math.floor(p.x) === pos.x && 
                     Math.floor(p.y) === pos.y && 
                     !p.carriedBy
            );
            
            if (parcelHere) {
                console.log(`[Collector] Picking up at spawn (${pos.x}, ${pos.y})`);
                this.succeed();
                this.clearCachedGoal();
                return { action: 'pickup' };
            }
        }
        
        // If any spawn tiles have parcels, go to the closest one
        if (spawnTilesWithParcels.length > 0) {
            // Find closest spawn tile with a parcel
            let closest = spawnTilesWithParcels[0];
            let minDist = manhattanDistance(pos.x, pos.y, closest.tile.x, closest.tile.y);
            
            for (const item of spawnTilesWithParcels) {
                const dist = manhattanDistance(pos.x, pos.y, item.tile.x, item.tile.y);
                if (dist < minDist) {
                    minDist = dist;
                    closest = item;
                }
            }
            
            console.log(`[Collector] Moving to spawn (${closest.tile.x}, ${closest.tile.y}) with parcel`);
            return this.stepToward(pos, closest.tile, 'spawn-with-parcel');
        }
        
        // No parcels at any spawn - go to designated spawn tile and wait
        if (pos.x === this.spawnTile.x && pos.y === this.spawnTile.y) {
            console.log('[Collector] Waiting for parcel at designated spawn');
            return null;
        }
        
        console.log(`[Collector] No parcels visible, moving to designated spawn (${this.spawnTile.x}, ${this.spawnTile.y})`);
        return this.stepToward(pos, this.spawnTile, 'designated-spawn');
    }

    goToHandoverAndDrop(pos) {
        // ═══════════════════════════════════════════════════════════════════
        // ROBUSTNESS: Detect if stuck and bypass handover
        // ═══════════════════════════════════════════════════════════════════
        
        // Track position changes
        const posKey = `${pos.x},${pos.y}`;
        if (this.lastPosition === posKey) {
            this.stuckCounter++;
        } else {
            this.stuckCounter = 0;
            this.lastPosition = posKey;
        }
        
        // If stuck for too long, bypass handover and deliver directly
        if (this.stuckCounter >= this.MAX_STUCK_TICKS) {
            console.log(`[Collector] Stuck for ${this.stuckCounter} ticks, bypassing handover and delivering directly!`);
            return this.bypassHandoverAndDeliverDirect(pos);
        }
        
        // If already on handover, drop only when courier is adjacent (so it can pick up quickly).
        if (pos.x === this.handoverTile.x && pos.y === this.handoverTile.y) {
            if (this.isCourierReady()) {
                console.log('[Collector] Dropping at handover');
                this.succeed();
                this.clearCachedGoal();
                this.stuckCounter = 0; // Reset
                return { action: 'putdown' };
            }

            console.log('[Collector] Waiting for courier');
            return null;
        }

        // If someone is currently sitting on the handover tile, do NOT plan to it.
        // Stage on the spawn-side adjacent tile instead (prevents A* returning empty in 1-wide corridors).
        const handoverOccupied = this.beliefs.isBlocked(this.handoverTile.x, this.handoverTile.y);
        if (handoverOccupied) {
            const staging = this.getStagingTile();
            if (!staging) {
                console.log('[Collector] No staging tile, waiting...');
                return null; // Don't fail, just wait
            }

            if (pos.x === staging.x && pos.y === staging.y) {
                console.log('[Collector] Staging: waiting for handover tile to free');
                return null;
            }

            console.log(`[Collector] Staging near handover (${staging.x}, ${staging.y})`);
            return this.stepToward(pos, staging, 'staging');
        }

        console.log(`[Collector] Moving to handover (${this.handoverTile.x}, ${this.handoverTile.y})`);
        return this.stepToward(pos, this.handoverTile, 'handover');
    }
    
    /**
     * Bypass handover and deliver directly to delivery tile
     * Used when handover is persistently blocked by other agents
     */
    bypassHandoverAndDeliverDirect(pos) {
        // Find closest delivery tile
        const deliveryTile = this.getClosestDeliveryTile(pos.x, pos.y);
        
        if (!deliveryTile) {
            console.log('[Collector] No delivery tile found, failing...');
            this.fail("No delivery tile");
            this.stuckCounter = 0;
            return null;
        }
        
        // Check if on delivery tile
        if (pos.x === deliveryTile.x && pos.y === deliveryTile.y) {
            console.log('[Collector] Delivering directly (bypassed handover)');
            this.succeed();
            this.clearCachedGoal();
            this.stuckCounter = 0;
            return { action: 'putdown' };
        }
        
        // Move to delivery
        console.log(`[Collector] Bypassing handover, going directly to delivery (${deliveryTile.x}, ${deliveryTile.y})`);
        return this.stepToward(pos, deliveryTile, 'bypass-delivery');
    }

    getStagingTile() {
        if (this.stagingTile) return this.stagingTile;

        const candidates = this.beliefs.environment.map[this.handoverTile.y][this.handoverTile.x].getNeighbors();
        if (candidates.length === 0) return null;

        // Prefer the neighbor closer to spawn (spawn-side).
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
        if (!this.coordination || !this.coordination.getPartnerId()) return true;

        const partner = this.beliefs.agents.find(a => a.id === this.coordination.getPartnerId());
        if (!partner) return false;

        const partnerPos = { x: Math.floor(partner.x), y: Math.floor(partner.y) };
        const dist = Math.abs(partnerPos.x - this.handoverTile.x) + Math.abs(partnerPos.y - this.handoverTile.y);

        // Adjacent OR on the handover tile (rare but acceptable if your collision resolver clears it)
        return dist <= 1;
    }

    stepToward(pos, goal, goalName) {
        this.ensurePartnerIgnoredPath(pos, goal);

        if (!this.path || this.path.length === 0) {
            console.log(`[Collector] No path to ${goalName} from (${pos.x},${pos.y}) to (${goal.x},${goal.y})`);
            console.log(`[Collector] Waiting for path to become available...`);
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
 * Courier Plan: wait on the delivery-side adjacent cell, pick up from handover when parcel is present,
 * then deliver to a delivery tile.
 */
export class CourierPlan extends Plan {
    constructor(beliefs, pathfinding, deliveryTile, handoverTile, coordination) {
        super(beliefs, pathfinding, coordination);

        this.deliveryTile = deliveryTile;
        this.handoverTile = handoverTile;

        this.waitingTile = null;     // delivery-side adjacent to handover
        this.cachedGoal = null;      // key
        
        console.log(`[CourierPlan] Created with delivery (${deliveryTile.x},${deliveryTile.y}), handover (${handoverTile.x},${handoverTile.y})`);
    }

    getAction() {
        const pos = { x: Math.floor(this.beliefs.x), y: Math.floor(this.beliefs.y) };
        const hasParcel = this.beliefs.hasParcel();

        // Validate position
        if (pos.x === -1 || pos.y === -1) {
            console.log('[Courier] Invalid position, waiting...');
            return null;
        }

        const parcelAtHandover = this.beliefs.parcels.find(p =>
            p.x === this.handoverTile.x &&
            p.y === this.handoverTile.y &&
            !p.carriedBy
        );

        if (!hasParcel) {
            if (parcelAtHandover) {
                return this.pickupFromHandover(pos);
            }
            return this.waitNearHandover(pos);
        }

        return this.deliverParcel(pos);
    }

    pickupFromHandover(pos) {
        // If someone is on the handover tile, wait (don't cause A* to fail by targeting an occupied cell).
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
        const waitPos = this.getWaitingTile();
        if (!waitPos) {
            console.log('[Courier] No waiting tile, waiting in place...');
            return null; // Don't fail, just wait
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

        // Prefer the neighbor closer to delivery (delivery-side), but never pick the handover tile itself.
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
        this.ensurePartnerIgnoredPath(pos, goal);

        if (!this.path || this.path.length === 0) {
            console.log(`[Courier] ⚠ No path to ${goalName} from (${pos.x},${pos.y}) to (${goal.x},${goal.y})`);
            console.log(`[Courier] Waiting for path to become available...`);
            this.clearCachedGoal();
            return null; // DON'T FAIL - just wait
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