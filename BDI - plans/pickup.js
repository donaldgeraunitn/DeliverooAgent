import { isSame, manhattanDistance } from "../Util/utils.js";
import { Plan } from "./plan.js";
import { BanList } from "../Util/banlist.js";

export class Pickup extends Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        super(beliefs, pathfinding, coordination);

        this.bans = new BanList(this.beliefs.config.BAN_DURATION);
        this.targetParcel = null;
    }

    updateTarget() {
        const candidates = this.beliefs.getAvailableParcels()
            .filter(parcel => !this.bans.isBanned(parcel.id))
            .filter(parcel => {
                const x = Math.floor(this.beliefs.x);
                const y = Math.floor(this.beliefs.y);
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);

                const myDistance = manhattanDistance(x, y, parcel_x, parcel_y);
                
                for (const agent of this.beliefs.agents) {
                    if (agent.id === this.beliefs.id) continue;
                    
                    // Skip partner if in coordination mode
                    if (this.coordination && this.beliefs.partnerId && agent.id === this.beliefs.partnerId) {
                        continue;
                    }
                    
                    const agent_x = Math.floor(agent.x);
                    const agent_y = Math.floor(agent.y);
                    const agentDistance = manhattanDistance(agent_x, agent_y, parcel_x, parcel_y);
                    
                    if (agentDistance + 1 < myDistance) return false;
                }
                
                return true;
            });

        let filteredCandidates = candidates;

        // Filter by zone if assigned
        if (this.beliefs.myArea && this.beliefs.myArea.length > 0) {
            const zoneParcels = candidates.filter(parcel => {
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);
                
                return this.beliefs.myArea.some(tile => 
                    tile.x === parcel_x && tile.y === parcel_y
                );
            });
            
            if (zoneParcels.length > 0) {
                console.log(`[Pickup] Found ${zoneParcels.length} parcels in my zone (${candidates.length} total)`);
                filteredCandidates = zoneParcels;
            } else {
                console.log(`[Pickup] No parcels in my zone, considering all ${candidates.length} parcels`);
            }
        }

        if (this.targetParcel) {
            const stillThere = filteredCandidates.find(parcel => parcel.id === this.targetParcel.id);
            if (stillThere) return;

            this.clearPath();
        }

        const best = this.selectBestParcel(filteredCandidates);
        this.targetParcel = best;
        this.clearPath();
    }

    selectBestParcel(candidates) {
        if (candidates.length === 0) return null;

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        const deliverUtility = this.calculateUtility(current_x, current_y, null);

        let bestParcel = null;
        let bestUtility = 0;

        for (const parcel of candidates) {
            const parcel_x = Math.floor(parcel.x);
            const parcel_y = Math.floor(parcel.y);  
            if (parcel.carriedBy || this.isBlocked(parcel_x, parcel_y)) continue;

            const pickupUtility = this.calculateUtility(current_x, current_y, parcel);
            if (pickupUtility > deliverUtility && pickupUtility > bestUtility) {
                bestUtility = pickupUtility;
                bestParcel = parcel;
            }
        }

        return bestParcel;
    }

    onActionResult(act, success, info = {}) {
        super.onActionResult(act, success, info);

        if (!success && act && act.action === "pickup" && act.id != null) {
            this.bans.ban(act.id);
            if (this.targetParcel && this.targetParcel.id === act.id) this.targetParcel = null;
            this.clearPath();
        }

        if (success && act && act.action === "pickup") {
            this.targetParcel = null;
            this.clearPath();
        }
    }

    getAction() {
        this.bans.incrementTime();

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        if (current_x === -1 && current_y === -1) return null;

        if (!this.targetParcel) this.updateTarget();
        
        if (!this.targetParcel) {
            this.fail("No suitable parcel available");
            return null;
        }

        const target_x = Math.floor(this.targetParcel.x);
        const target_y = Math.floor(this.targetParcel.y);

        if (isSame(current_x, current_y, target_x, target_y)) {
            const targetId = this.targetParcel.id;
            this.targetParcel = null;
            this.clearPath();
            return { action: "pickup", id: targetId };
        }

        this.ensurePath(current_x, current_y, target_x, target_y);

        if (this.path.length === 0) {
            console.log(`[Pickup] No path to parcel ${this.targetParcel.id}, banning`);
            this.bans.ban(this.targetParcel.id);
            this.fail("No path to target parcel");
            this.targetParcel = null;
            this.clearPath();
            return null;
        }

        return this.followPath(current_x, current_y);
    }

    getTargetParcel() {
        return this.targetParcel;
    }
}