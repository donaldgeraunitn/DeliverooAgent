import { isSame, manhattanDistance } from "../Util/utils.js";
import { Plan } from "./plan.js";
import { BanList } from "../Util/banlist.js";

export class Deliver extends Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        super(beliefs, pathfinding, coordination);

        this.targetParcel = null;
        this.deliveryBans = new BanList(this.beliefs.config.BAN_DURATION);
        this.parcelBans = new BanList(this.beliefs.config.BAN_DURATION); // Ban disappeared parcels
        this.recentlyPickedUp = new Set(); // Track parcels picked up this delivery cycle
    }

    shouldDeliver() {
        return this.beliefs.hasParcel();
    }

    selectParcel(current_x, current_y) {
        const carriedCount = this.beliefs.getCarriedParcels().length;
        if (carriedCount >= this.beliefs.config.MAX_PARCELS_DETOUR) {
            console.log(`[Deliver] Already carrying ${carriedCount} parcels, skipping detour`);
            return null;
        }
        
        const deliverUtility = this.calculateUtility(current_x, current_y, null);

        const candidates = this.beliefs.getAvailableParcels()
            .filter(parcel => !parcel.carriedBy)
            .filter(parcel => !this.recentlyPickedUp.has(parcel.id)) // Avoid re-picking same parcel
            .filter(parcel => !this.parcelBans.isBanned(parcel.id)) // Avoid disappeared parcels
            .filter(parcel => {
                // ═══════════════════════════════════════════════════════════════════
                // FILTER 1: OBSERVATION RANGE - Only consider parcels we can see
                // ═══════════════════════════════════════════════════════════════════
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);
                
                if (!this.beliefs.isVisible(parcel_x, parcel_y)) {
                    return false;
                }
                
                return true;
            })
            .filter(parcel => {
                // ═══════════════════════════════════════════════════════════════════
                // FILTER 2: PROXIMITY - Don't steal parcels other agents are closer to
                // ═══════════════════════════════════════════════════════════════════
                
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);
                const myDistance = manhattanDistance(current_x, current_y, parcel_x, parcel_y);
                
                for (const agent of this.beliefs.agents) {
                    if (agent.id === this.beliefs.id) continue;
                    
                    // Skip partner check in coordination mode
                    if (this.coordination && this.beliefs.partnerId && agent.id === this.beliefs.partnerId) {
                        continue;
                    }
                    
                    const agent_x = Math.floor(agent.x);
                    const agent_y = Math.floor(agent.y);
                    const agentDistance = manhattanDistance(agent_x, agent_y, parcel_x, parcel_y);
                    
                    // If other agent is significantly closer, skip this parcel
                    if (agentDistance + 1 < myDistance) {
                        return false;
                    }
                }
                
                return true;
            });

        let bestParcel = null;
        let bestUtility = -Infinity;

        for (const parcel of candidates) {
            const pickupUtility = this.calculateUtility(current_x, current_y, parcel);

            // To SELECT a new detour: must be significantly better than delivery
            if (pickupUtility > deliverUtility && pickupUtility > bestUtility + this.beliefs.config.DETOUR_UTILITY_THRESHOLD) {
                bestUtility = pickupUtility;
                bestParcel = parcel;
            }
        }

        return bestParcel;
    }

    getAction() {
        this.deliveryBans.incrementTime();
        this.parcelBans.incrementTime(); // Increment parcel ban timer

        if (!this.shouldDeliver()) {
            this.clearPath();
            this.targetParcel = null;
            return null;
        }

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        if (current_x === -1 && current_y === -1) return null;

        if (this.beliefs.environment.isDelivery(current_x, current_y)) {
            this.clearPath();
            this.targetParcel = null;
            this.recentlyPickedUp.clear(); // Clear tracking after delivery
            return { action: "putdown" };
        }

        if (this.targetParcel) {
            // Check if target still visible in our current beliefs
            const stillVisible = this.beliefs.parcels.find( p => p.id === this.targetParcel.id && !p.carriedBy && !this.recentlyPickedUp.has(p.id) );
            
            if (!stillVisible) {
                // Parcel not in beliefs - check if we can see where it should be
                const targetPos = { x: Math.floor(this.targetParcel.x), y: Math.floor(this.targetParcel.y) };
                const canSeeTargetLocation = this.beliefs.isVisible(targetPos.x, targetPos.y);
                
                if (canSeeTargetLocation) {
                    // We CAN see the location, but parcel is not there → Confirmed: it was picked up or decayed
                    console.log(`[Deliver] Target parcel ${this.targetParcel.id} confirmed gone (visible area), banning`);
                    this.parcelBans.ban(this.targetParcel.id);
                    this.targetParcel = null;
                    this.clearPath();
                } else {
                    // We CANNOT see the location - parcel might still be there  → Keep moving toward it (optimistic)
                    console.log(`[Deliver] Target parcel ${this.targetParcel.id} out of sight, continuing optimistically`);
                    
                    const detour_x = Math.floor(this.targetParcel.x);
                    const detour_y = Math.floor(this.targetParcel.y);
                    
                    if (isSame(current_x, current_y, detour_x, detour_y)) {
                        // Reached the location but no parcel - it's really gone
                        console.log(`[Deliver] Reached target location but parcel ${this.targetParcel.id} not here, banning`);
                        this.parcelBans.ban(this.targetParcel.id);
                        this.targetParcel = null;
                        this.clearPath();
                        // Fall through to re-evaluate
                    } else {
                        // Continue moving to last known position
                        this.ensurePath(current_x, current_y, detour_x, detour_y);
                        if (this.path.length > 0) {
                            console.log(`[Deliver] Continuing to out-of-sight parcel ${this.targetParcel.id}`);
                            return this.followPath(current_x, current_y);
                        } else {
                            console.log(`[Deliver] No path to out-of-sight parcel ${this.targetParcel.id}, banning`);
                            this.parcelBans.ban(this.targetParcel.id);
                            this.targetParcel = null;
                            this.clearPath();
                        }
                    }
                }
            } 
            else {
                const detourUtility = this.calculateUtility(current_x, current_y, this.targetParcel);
                const deliverUtility = this.calculateUtility(current_x, current_y, null);
                
                const shouldKeep = detourUtility > deliverUtility + this.beliefs.config.DETOUR_UTILITY_THRESHOLD;
                
                if (!shouldKeep) {
                    console.log(`[Deliver] Abandoning detour to ${this.targetParcel.id} (delivery now significantly better)`);
                    this.targetParcel = null;
                    this.clearPath();
                } else {
                    // Keep the detour target
                    const detour_x = Math.floor(this.targetParcel.x);
                    const detour_y = Math.floor(this.targetParcel.y);

                    if (isSame(current_x, current_y, detour_x, detour_y)) {
                        // Verify parcel is actually here before picking up
                        const parcelHere = this.beliefs.parcels.find(
                            p => p.id === this.targetParcel.id && 
                                 Math.floor(p.x) === current_x && 
                                 Math.floor(p.y) === current_y &&
                                 !p.carriedBy
                        );
                        
                        if (parcelHere) {
                            this.recentlyPickedUp.add(this.targetParcel.id);
                            console.log(`[Deliver] Picking up detour parcel ${this.targetParcel.id}`);
                            const targetId = this.targetParcel.id;
                            this.targetParcel = null;
                            this.clearPath();
                            return { action: "pickup", id: targetId };
                        } else {
                            console.log(`[Deliver] Reached target location but parcel ${this.targetParcel.id} not here, banning`);
                            this.parcelBans.ban(this.targetParcel.id);
                            this.targetParcel = null;
                            this.clearPath();
                            // Fall through to re-evaluate
                        }
                    }

                    this.ensurePath(current_x, current_y, detour_x, detour_y);
                    if (this.path.length > 0) {
                        console.log(`[Deliver] Continuing detour to ${this.targetParcel.id}`);
                        return this.followPath(current_x, current_y);
                    } else {
                        console.log(`[Deliver] No path to detour ${this.targetParcel.id}, banning`);
                        this.parcelBans.ban(this.targetParcel.id); // ← BAN unreachable parcels
                        this.targetParcel = null;
                        this.clearPath();
                    }
                }
            }
        }

        if (!this.targetParcel) {
            const detour = this.selectParcel(current_x, current_y); // Select new detour
            if (detour) {
                this.targetParcel = detour;

                const detour_x = Math.floor(detour.x);
                const detour_y = Math.floor(detour.y);

                if (isSame(current_x, current_y, detour_x, detour_y)) {
                    const parcelHere = this.beliefs.parcels.find( parcel => parcel.id === detour.id && Math.floor(parcel.x) === current_x &&  Math.floor(parcel.y) === current_y &&!parcel.carriedBy );
                    
                    if (parcelHere) {
                        this.recentlyPickedUp.add(detour.id);
                        console.log(`[Deliver] Picking up detour parcel ${detour.id}`);
                        this.targetParcel = null;
                        return { action: "pickup", id: detour.id };
                    } 
                    else {
                        console.log(`[Deliver] Parcel ${detour.id} not at current location, banning`);
                        this.parcelBans.ban(detour.id);
                        this.targetParcel = null;
                    }
                }

                this.ensurePath(current_x, current_y, detour_x, detour_y);
                if (this.path.length > 0) {
                    console.log(`[Deliver] Starting detour to parcel ${detour.id}`);
                    return this.followPath(current_x, current_y);
                } 
                else {
                    console.log(`[Deliver] No path to detour parcel ${detour.id}, banning`);
                    this.parcelBans.ban(detour.id);
                    this.targetParcel = null;
                }
            }
        }

        const deliveryTile = this.getClosestDeliveryTile(current_x, current_y, this.deliveryBans);
        if (!deliveryTile) {
            this.fail("All delivery tiles banned");
            this.clearPath();
            return null;
        }

        this.ensurePath(current_x, current_y, deliveryTile.x, deliveryTile.y);
        
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
        let closestTile = null;
        let minDistance = Infinity;

        for (const tile of this.beliefs.environment.deliveryTiles) {
            const tileKey = tile.tileKey();
            if (this.deliveryBans && this.deliveryBans.isBanned(tileKey)) {
                console.log(`[Environment] - Skipping banned delivery tile (${tile.x}, ${tile.y})`);
                continue;
            }

            const distance = this.pathfinding.AStar(x, y, tile.x, tile.y).length; // Use path length instead of Manhattan distance
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