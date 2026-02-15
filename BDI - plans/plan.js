import { manhattanDistance, isSame } from "../Utils/utils.js";

export class Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        this.beliefs = beliefs;
        this.pathfinding = pathfinding;
        this.coordination = coordination;

        this.path = [];
        this.target = null;
        this.failedAttempts = 0;
        this.lastFailureReason = null;
        
        // Collision handling (for normal mode only)
        this.collisionRetries = 0;
        this.lastCollisionTime = 0;
    }

    resetFailures() {
        this.failedAttempts = 0;
        this.lastFailureReason = null;
    }

    fail(reason = "failed") {
        this.failedAttempts += 1;
        this.lastFailureReason = reason;
        console.log(`[Plan] Failure ${this.failedAttempts}/${this.beliefs.config.MAX_FAILED_ATTEMPTS}: ${reason}`);
    }

    succeed() {
        this.failedAttempts = 0;
        this.lastFailureReason = null;
        this.collisionRetries = 0;
    }

    shouldAbort() {
        return this.failedAttempts >= this.beliefs.config.MAX_FAILED_ATTEMPTS;
    }

    clearPath() {
        this.path = [];
        this.target = null;
    }

    isTarget(target_x, target_y) {
        return this.target && this.target.x === target_x && this.target.y === target_y && this.path.length > 0;
    }

    ensurePath(start_x, start_y, target_x, target_y) {
        if (!this.isTarget(target_x, target_y)) {
            this.path = this.pathfinding.AStar(start_x, start_y, target_x, target_y);
            this.target = { x: target_x, y: target_y };
        }
    }

    isBlocked(target_x, target_y) {
        const agents = this.beliefs.agents;
        if (!agents) return false;

        return agents.some(agent => agent.id !== this.beliefs.id && Math.floor(agent.x) === target_x && Math.floor(agent.y) === target_y);
    }

    followPath(current_x, current_y) {
        if (this.path.length === 0) {
            this.target = null;
            return null;
        }

        const nextStep = this.path[0];
        const next_x = nextStep.x;
        const next_y = nextStep.y;

        // Detect stale paths
        const distance = Math.abs(next_x - current_x) + Math.abs(next_y - current_y);
        if (distance !== 1) {
            console.log(`[Plan] Path stale: from (${current_x},${current_y}) to (${next_x},${next_y}) is ${distance} tiles`);
            this.clearPath();
            return null;
        }

        // Check if next step is blocked
        const isHandoverMode = this.coordination && this.coordination.isHandoverMode();
        
        if (!isHandoverMode && this.isBlocked(next_x, next_y)) {
            // Normal mode: use smart collision handling
            return this.handleBlockedPath(current_x, current_y, next_x, next_y);
        }
        
        // In handover mode: Skip blocking check entirely
        // Paths are computed with ignoreAgentIds, so partner may be on path
        // This is expected and handled by handover plan's staging logic

        const direction = this.pathfinding.toAction(current_x, current_y, next_x, next_y);
        if (!direction) {
            this.fail(`Invalid move from (${current_x}, ${current_y}) to (${next_x}, ${next_y})`);
            this.clearPath();
            return null;
        }

        this.path.shift();
        return { action: direction };
    }

    handleBlockedPath(current_x, current_y, next_x, next_y) {
        const blockingAgent = this.beliefs.agents.find(
            agent => agent.id !== this.beliefs.id && 
                    Math.floor(agent.x) === next_x && 
                    Math.floor(agent.y) === next_y
        );

        if (!blockingAgent) {
            // Ghost blocking? Replan
            console.log(`[Plan] Phantom block at (${next_x}, ${next_y}), replanning`);
            this.clearPath();
            return null;
        }

        // Check if it's partner blocking
        const isPartner = this.coordination && blockingAgent.id === this.beliefs.partnerId;

        if (isPartner) {
            return this.handlePartnerCollision(current_x, current_y, next_x, next_y);
        } else {
            return this.handleNonPartnerCollision(current_x, current_y, next_x, next_y, blockingAgent);
        }
    }

    handlePartnerCollision(current_x, current_y, next_x, next_y) {
        const now = Date.now();

        // Check for collision timeout
        if (this.collisionRetries > 0) {
            const timeWaiting = now - this.lastCollisionTime;
            
            if (timeWaiting > this.beliefs.config.MOVEMENT_DURATION * 2) {
                console.log(`[Plan] Collision timeout after ${timeWaiting}ms, attempting alternative path`);
                this.collisionRetries = 0;
                return this.tryAlternativePath(current_x, current_y);
            }
        }

        // Initiate or continue collision resolution
        if (this.collisionRetries < this.beliefs.config.MAX_COLLISION_RETRIES) {
            if (this.collisionRetries === 0) {
                this.lastCollisionTime = now;
            }

            console.log(`[Plan] Partner blocking at (${next_x}, ${next_y}), collision attempt ${this.collisionRetries + 1}/${this.maxCollisionRetries}`);
            
            this.coordination.initiateCollisionResolution({
                blockedTile: { x: next_x, y: next_y },
                myHasParcels: this.beliefs.hasParcel()
            });

            this.collisionRetries++;
            return null; // Wait
        }

        // Max retries reached, try alternative path
        console.log(`[Plan] Collision resolution failed after ${this.beliefs.config.MAX_COLLISION_RETRIES} attempts, seeking alternative`);
        this.collisionRetries = 0;
        return this.tryAlternativePath(current_x, current_y);
    }

    handleNonPartnerCollision(current_x, current_y, next_x, next_y, blockingAgent) {
        console.log(`[Plan] Non-partner agent ${blockingAgent.id} blocking at (${next_x}, ${next_y}), replanning`);
        
        // Try to find alternative path that avoids this agent
        return this.tryAlternativePath(current_x, current_y);
    }

    tryAlternativePath(current_x, current_y) {
        if (!this.target) {
            this.fail('No target for alternative path');
            return null;
        }

        console.log(`[Plan] Searching for alternative path to (${this.target.x}, ${this.target.y})`);

        // Try pathfinding with temporary blockages
        const alternativePath = this.pathfinding.AStar(
            current_x, current_y, 
            this.target.x, this.target.y
        );

        if (alternativePath.length > 0) {
            console.log(`[Plan] Found alternative path (length: ${alternativePath.length})`);
            this.path = alternativePath;
            this.collisionRetries = 0;
            
            // Try first step of alternative path
            return this.followPath(current_x, current_y);
        }

        // No alternative path found, try waiting
        console.log(`[Plan] No alternative path found, waiting for agent to move`);
        this.fail('No alternative path available');
        
        // Don't clear path yet - maybe agent will move
        return null;
    }

    calculateUtility(current_x, current_y, parcel = null) {
        if (current_x === -1 && current_y === -1) return -Infinity;

        const carriedParcels = this.beliefs.getCarriedParcels();
        const carriedReward = carriedParcels.reduce((sum, p) => sum + p.reward, 0);
        const carriedCount = carriedParcels.length;

        const lossPerMovement = this.beliefs.config.LOSS_PER_MOVEMENT;
        const env = this.beliefs.environment;

        if (parcel === null) {
            if (carriedCount === 0) return 0;
            if (env.isDelivery(current_x, current_y)) return Infinity;

            const deliveryTile = this.getClosestDeliveryTile(current_x, current_y);
            if (!deliveryTile) return -Infinity;

            const pathToDelivery = this.pathfinding.AStar(current_x, current_y, deliveryTile.x, deliveryTile.y);
            const stepsToDelivery = pathToDelivery.length;

            if (stepsToDelivery === 0 && !isSame(current_x, current_y, deliveryTile.x, deliveryTile.y)) return -Infinity;

            return carriedReward - (stepsToDelivery * lossPerMovement * carriedCount);
        }

        if (parcel.carriedBy) return -Infinity;

        const pathToParcel = this.pathfinding.AStar(current_x, current_y, parcel.x, parcel.y);
        const stepsToParcel = pathToParcel.length;

        if (stepsToParcel === 0 && !isSame(current_x, current_y, parcel.x, parcel.y)) return -Infinity;

        const deliveryFromParcel = this.getClosestDeliveryTile(parcel.x, parcel.y);
        if (!deliveryFromParcel) return -Infinity;

        const pathParcelToDelivery = this.pathfinding.AStar(parcel.x, parcel.y, deliveryFromParcel.x, deliveryFromParcel.y);
        const stepsParcelToDelivery = pathParcelToDelivery.length;

        if (stepsParcelToDelivery === 0 && !isSame(parcel.x, parcel.y, deliveryFromParcel.x, deliveryFromParcel.y)) return -Infinity;

        return (parcel.reward + carriedReward) - ((stepsToParcel + stepsParcelToDelivery) * lossPerMovement * (carriedCount + 1));
    }

    getClosestDeliveryTile(x, y) {
        let closestTile = null;
        let minDistance = Infinity;

        for (const tile of this.beliefs.environment.deliveryTiles) {
            const tileKey = tile.tileKey();
            const distance = this.pathfinding.AStar(x, y, tile.x, tile.y).length; // Use path length instead of Manhattan distance
            if (distance < minDistance) {
                minDistance = distance;
                closestTile = tile;
            }
        }

        return closestTile;
    }
}