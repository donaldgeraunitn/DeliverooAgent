import { isSame, manhattanDistance } from "../Utils/utils.js";
import { Plan } from "./plan.js";
import { BanList } from "../Utils/banlist.js";

export class Deliver extends Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        super(beliefs, pathfinding, coordination);

        // Current optional “detour” parcel we are targeting before resuming delivery
        this.targetParcel = null;

        // Temporary bans to avoid repeatedly selecting unreachable/failed tiles/parcels
        this.deliveryBans = new BanList(this.beliefs.config.BAN_DURATION);
        this.parcelBans = new BanList(this.beliefs.config.BAN_DURATION);

        // Per delivery-cycle memory to avoid immediately re-targeting the same parcel
        this.recentlyPickedUp = new Set();
    }

    shouldDeliver() {
        // Deliver plan is relevant only if we are currently carrying at least one parcel
        return this.beliefs.hasParcel();
    }

    selectParcel(current_x, current_y) {
        // Safety guard: if already carrying many parcels, do not take extra detours
        const carriedCount = this.beliefs.getCarriedParcels().length;
        if (carriedCount >= this.beliefs.config.MAX_PARCELS_DETOUR) {
            console.log(`[Deliver] Already carrying ${carriedCount} parcels, skipping detour`);
            return null;
        }

        // Utility baseline: “just go deliver now”
        const deliverUtility = this.calculateUtility(current_x, current_y, null);

        // Build candidate detour parcels (strict filters to reduce wasted moves/stealing)
        const candidates = this.beliefs.getAvailableParcels()
            .filter(parcel => !this.recentlyPickedUp.has(parcel.id))     // avoid immediate re-pick
            .filter(parcel => !this.parcelBans.isBanned(parcel.id))      // avoid known-gone parcels
            .filter(parcel => {
                // Only consider parcels within our observation (avoid chasing stale beliefs)
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);
                return this.beliefs.isVisible(parcel_x, parcel_y);
            })
            .filter(parcel => {
                // Do not pursue a parcel if another agent is clearly closer (simple “no stealing” rule)
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);
                const myDistance = manhattanDistance(current_x, current_y, parcel_x, parcel_y);

                for (const agent of this.beliefs.agents) {
                    if (agent.id === this.beliefs.id) continue;

                    // In coordination mode, do not compete with the partner for detours
                    if (this.coordination && this.beliefs.partnerId && agent.id === this.beliefs.partnerId) {
                        continue;
                    }

                    const agent_x = Math.floor(agent.x);
                    const agent_y = Math.floor(agent.y);
                    const agentDistance = manhattanDistance(agent_x, agent_y, parcel_x, parcel_y);

                    if (agentDistance + this.beliefs.config.AGENT_OBSERVATION_DISTANCE * 0.3 < myDistance) {
                        return false;
                    }
                }

                return true;
            });

        // Choose the detour parcel that is meaningfully better than delivering now
        let bestParcel = null;
        let bestUtility = -Infinity;

        for (const parcel of candidates) {
            const pickupUtility = this.calculateUtility(current_x, current_y, parcel);

            // Detour must beat delivery baseline AND pass a threshold to avoid tiny gains
            if (pickupUtility > deliverUtility && pickupUtility > bestUtility + this.beliefs.config.DETOUR_UTILITY_THRESHOLD) {
                bestUtility = pickupUtility;
                bestParcel = parcel;
            }
        }

        return bestParcel;
    }

    getAction() {
        // Advance ban timers each tick
        this.deliveryBans.incrementTime();
        this.parcelBans.incrementTime();

        // If we are not carrying anything, this plan is not active
        if (!this.shouldDeliver()) {
            this.clearPath();
            this.targetParcel = null;
            return null;
        }

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        // Uninitialized belief position
        if (current_x === -1 && current_y === -1) return null;

        // If standing on a delivery tile, putdown and reset cycle-local state
        if (this.beliefs.environment.isDelivery(current_x, current_y)) {
            this.clearPath();
            this.targetParcel = null;
            this.recentlyPickedUp.clear();
            return { action: "putdown" };
        }

        // If we are currently on a detour, validate and continue (or abandon) the detour
        if (this.targetParcel) {
            // Target is considered “still valid” only if we still believe it exists and is free
            const stillVisible = this.beliefs.parcels.find( p => p.id === this.targetParcel.id && !p.carriedBy && !this.recentlyPickedUp.has(p.id) );

            if (!stillVisible) {
                // Parcel not in beliefs; decide whether it is truly gone or just out of sight
                const targetPos = { x: Math.floor(this.targetParcel.x), y: Math.floor(this.targetParcel.y) };
                const canSeeTargetLocation = this.beliefs.isVisible(targetPos.x, targetPos.y);

                if (canSeeTargetLocation) {
                    // If we can see the location and it is not there, mark it as gone
                    console.log(`[Deliver] Target parcel ${this.targetParcel.id} confirmed gone (visible area), banning`);
                    this.parcelBans.ban(this.targetParcel.id);
                    this.targetParcel = null;
                    this.clearPath();
                } 
                else {
                    // If we cannot see it, keep moving optimistically to last known position
                    console.log(`[Deliver] Target parcel ${this.targetParcel.id} out of sight, continuing optimistically`);

                    const detour_x = Math.floor(this.targetParcel.x);
                    const detour_y = Math.floor(this.targetParcel.y);

                    if (isSame(current_x, current_y, detour_x, detour_y)) {
                        // We reached the last known cell and it is not there -> ban and re-evaluate
                        console.log(`[Deliver] Reached target location but parcel ${this.targetParcel.id} not here, banning`);
                        this.parcelBans.ban(this.targetParcel.id);
                        this.targetParcel = null;
                        this.clearPath();
                        // Fall through to re-evaluate
                    } 
                    else {
                        // Continue moving toward last known position
                        this.ensurePath(current_x, current_y, detour_x, detour_y);
                        if (this.path.length > 0) {
                            console.log(`[Deliver] Continuing to out-of-sight parcel ${this.targetParcel.id}`);
                            return this.followPath(current_x, current_y);
                        } 
                        else {
                            // If pathfinding fails, ban this parcel to avoid repeated attempts
                            console.log(`[Deliver] No path to out-of-sight parcel ${this.targetParcel.id}, banning`);
                            this.parcelBans.ban(this.targetParcel.id);
                            this.targetParcel = null;
                            this.clearPath();
                        }
                    }
                }
            } 
            else {
                // If parcel is still believed present, re-check whether detour is still worth it
                const detourUtility = this.calculateUtility(current_x, current_y, this.targetParcel);
                const deliverUtility = this.calculateUtility(current_x, current_y, null);

                const shouldKeep = detourUtility > deliverUtility + this.beliefs.config.DETOUR_UTILITY_THRESHOLD;

                if (!shouldKeep) {
                    // Drop detour if delivering now becomes decisively better
                    console.log(`[Deliver] Abandoning detour to ${this.targetParcel.id} (delivery now significantly better)`);
                    this.targetParcel = null;
                    this.clearPath();
                } 
                else {
                    // Continue detour toward target parcel
                    const detour_x = Math.floor(this.targetParcel.x);
                    const detour_y = Math.floor(this.targetParcel.y);

                    if (isSame(current_x, current_y, detour_x, detour_y)) {
                        // At target cell: pick up only if parcel is truly present right now
                        const parcelHere = this.beliefs.parcels.find( p => p.id === this.targetParcel.id && Math.floor(p.x) === current_x && Math.floor(p.y) === current_y && !p.carriedBy );

                        if (parcelHere) {
                            // Record as picked up so we don't target it again in this cycle
                            this.recentlyPickedUp.add(this.targetParcel.id);
                            console.log(`[Deliver] Picking up detour parcel ${this.targetParcel.id}`);
                            const targetId = this.targetParcel.id;
                            this.targetParcel = null;
                            this.clearPath();
                            return { action: "pickup", id: targetId };
                        } 
                        else {
                            // If absent at arrival, treat as gone and avoid retrying
                            console.log(`[Deliver] Reached target location but parcel ${this.targetParcel.id} not here, banning`);
                            this.parcelBans.ban(this.targetParcel.id);
                            this.targetParcel = null;
                            this.clearPath();
                            // Fall through to re-evaluate
                        }
                    }

                    // Move toward the detour target
                    this.ensurePath(current_x, current_y, detour_x, detour_y);
                    if (this.path.length > 0) {
                        console.log(`[Deliver] Continuing detour to ${this.targetParcel.id}`);
                        return this.followPath(current_x, current_y);
                    } 
                    else {
                        // Unreachable: ban this parcel ID to prevent repeated pathfinding
                        console.log(`[Deliver] No path to detour ${this.targetParcel.id}, banning`);
                        this.parcelBans.ban(this.targetParcel.id);
                        this.targetParcel = null;
                        this.clearPath();
                    }
                }
            }
        }

        // If no active detour, try to start one (if it is worth it)
        if (!this.targetParcel) {
            const detour = this.selectParcel(current_x, current_y);
            if (detour) {
                this.targetParcel = detour;

                const detour_x = Math.floor(detour.x);
                const detour_y = Math.floor(detour.y);

                if (isSame(current_x, current_y, detour_x, detour_y)) {
                    // Already on the parcel tile: pick up only if it is confirmed present
                    const parcelHere = this.beliefs.parcels.find(  parcel => parcel.id === detour.id && Math.floor(parcel.x) === current_x && Math.floor(parcel.y) === current_y && !parcel.carriedBy );

                    if (parcelHere) {
                        this.recentlyPickedUp.add(detour.id);
                        console.log(`[Deliver] Picking up detour parcel ${detour.id}`);
                        this.targetParcel = null;
                        return { action: "pickup", id: detour.id };
                    } 
                    else {
                        // If belief is stale at same-cell arrival, ban to avoid oscillation
                        console.log(`[Deliver] Parcel ${detour.id} not at current location, banning`);
                        this.parcelBans.ban(detour.id);
                        this.targetParcel = null;
                    }
                }

                // Start moving toward the selected detour parcel
                this.ensurePath(current_x, current_y, detour_x, detour_y);
                if (this.path.length > 0) {
                    console.log(`[Deliver] Starting detour to parcel ${detour.id}`);
                    return this.followPath(current_x, current_y);
                } 
                else {
                    // If unreachable from the start, ban and continue to delivery instead
                    console.log(`[Deliver] No path to detour parcel ${detour.id}, banning`);
                    this.parcelBans.ban(detour.id);
                    this.targetParcel = null;
                }
            }
        }

        // Default behavior: go to the best (closest) delivery tile that is not banned
        const deliveryTile = this.getClosestDeliveryTile(current_x, current_y, this.deliveryBans);
        if (!deliveryTile) {
            this.fail("All delivery tiles banned");
            this.clearPath();
            return null;
        }

        this.ensurePath(current_x, current_y, deliveryTile.x, deliveryTile.y);

        // If delivery is unreachable, ban the tile and signal failure to trigger replanning
        if (this.path.length === 0) {
            const tileKey = deliveryTile.tileKey();
            console.log(`[Deliver] No path to delivery (${deliveryTile.x}, ${deliveryTile.y}), banning tile`);
            this.deliveryBans.ban(tileKey);
            this.fail("No path to delivery tile");
            this.clearPath();
            return null;
        }

        return this.followPath(current_x, current_y);
    }

    getClosestDeliveryTile(x, y) {
        // Select delivery tile by shortest A* path length
        let closestTile = null;
        let minDistance = Infinity;

        for (const tile of this.beliefs.environment.deliveryTiles) {
            const tileKey = tile.tileKey();

            if (this.deliveryBans && this.deliveryBans.isBanned(tileKey)) {
                console.log(`[Environment] - Skipping banned delivery tile (${tile.x}, ${tile.y})`);
                continue;
            }

            const distance = this.pathfinding.AStar(x, y, tile.x, tile.y).length;
            if (distance < minDistance) {
                minDistance = distance;
                closestTile = tile;
            }
        }

        return closestTile;
    }

    getTargetParcel() {
        return this.targetParcel;
    }
}
