import { isSame, manhattanDistance } from "../Utils/utils.js";
import { Plan } from "./plan.js";
import { BanList } from "../Utils/banlist.js";

export class Pickup extends Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        super(beliefs, pathfinding, coordination);

        // Ban parcels that repeatedly fail pickup or are unreachable (avoid thrashing)
        this.bans = new BanList(this.beliefs.config.BAN_DURATION);

        // Current parcel target (may be null if no good target exists)
        this.targetParcel = null;
    }

    updateTarget() {
        // Build candidate parcels:
        //  - not banned
        //  - not “stolen” by other agents that are clearly closer (simple proximity rule)
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

                    // In coordination mode, do not compete with the partner
                    if (this.coordination && this.beliefs.partnerId && agent.id === this.beliefs.partnerId) {
                        continue;
                    }

                    const agent_x = Math.floor(agent.x);
                    const agent_y = Math.floor(agent.y);
                    const agentDistance = manhattanDistance(agent_x, agent_y, parcel_x, parcel_y);

                    // If another agent is clearly closer, skip this parcel
                    if (this.beliefs.config.AGENT_OBSERVATION_DISTANCE * 0.3  < myDistance) return false;
                }

                return true;
            });

        // Default: consider all candidates; if a zone is assigned, prefer parcels inside it
        let filteredCandidates = candidates;

        if (this.beliefs.myArea && this.beliefs.myArea.length > 0) {
            const zoneParcels = candidates.filter(parcel => {
                const parcel_x = Math.floor(parcel.x);
                const parcel_y = Math.floor(parcel.y);

                return this.beliefs.myArea.some(tile =>
                    tile.x === parcel_x && tile.y === parcel_y
                );
            });

            // If there are parcels in the zone, restrict to them; otherwise keep global set
            if (zoneParcels.length > 0) {
                console.log(`[Pickup] Found ${zoneParcels.length} parcels in my zone (${candidates.length} total)`);
                filteredCandidates = zoneParcels;
            } 
            else {
                console.log(`[Pickup] No parcels in my zone, considering all ${candidates.length} parcels`);
            }
        }

        // If we already have a target and it is still among valid candidates, keep it
        if (this.targetParcel) {
            const stillThere = filteredCandidates.find(parcel => parcel.id === this.targetParcel.id);
            if (stillThere) return;

            // Target is no longer valid -> drop current path and re-plan
            this.clearPath();
        }

        // Choose the “best” parcel according to utility (must beat delivering now)
        const best = this.selectBestParcel(filteredCandidates);
        this.targetParcel = best;

        // Force replanning from scratch when target changes
        this.clearPath();
    }

    selectBestParcel(candidates) {
        // No available candidates -> no target
        if (candidates.length === 0) return null;

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        // Baseline utility: delivering immediately (i.e., do not pickup more)
        const deliverUtility = this.calculateUtility(current_x, current_y, null);

        // Pick the parcel with the highest pickup utility that beats the delivery baseline
        let bestParcel = null;
        let bestUtility = 0;

        for (const parcel of candidates) {
            const parcel_x = Math.floor(parcel.x);
            const parcel_y = Math.floor(parcel.y);

            // Skip parcels already carried or located on blocked tiles
            if (parcel.carriedBy || this.isBlocked(parcel_x, parcel_y)) continue;

            const pickupUtility = this.calculateUtility(current_x, current_y, parcel);

            // Only consider parcels that make the overall plan better than delivering now
            if (pickupUtility > deliverUtility && pickupUtility > bestUtility) {
                bestUtility = pickupUtility;
                bestParcel = parcel;
            }
        }

        return bestParcel;
    }

    getAction() {
        // Advance ban timers each tick
        this.bans.incrementTime();

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        // Defensive guard for uninitialized belief position
        if (current_x === -1 && current_y === -1) return null;

        // Ensure we have a target (update selection when none is set)
        if (!this.targetParcel) this.updateTarget();

        // If still none, no good pickup exists right now
        if (!this.targetParcel) {
            this.fail("No suitable parcel available");
            return null;
        }

        const target_x = Math.floor(this.targetParcel.x);
        const target_y = Math.floor(this.targetParcel.y);

        // If already on the parcel tile, attempt pickup immediately
        if (isSame(current_x, current_y, target_x, target_y)) {
            const targetId = this.targetParcel.id;
            this.targetParcel = null;
            this.clearPath();
            return { action: "pickup", id: targetId };
        }

        // Otherwise, plan and follow a path to the target parcel
        this.ensurePath(current_x, current_y, target_x, target_y);

        // If unreachable, ban this parcel and force re-targeting
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
