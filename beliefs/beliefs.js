// beliefs.js
import { Environment } from './environment.js';
import { manhattanDistance } from '../utils/utils.js';

export class Belief {
    constructor() {
        this.environment = new Environment();
        
        // Agent state
        this.me = {
            id: null,
            name: null,
            x: 0,
            y: 0,
            score: 0,
            carriedParcels: []
        };

        // Parcels tracking
        this.parcels = new Map(); // id -> parcel object
        
        // Other agents
        this.agents = new Map(); // id -> agent object

        // Track failed attempts to reach parcels
        this.failedAttempts = new Map(); // parcel id -> count

        // Visit heatmap (initialized after map arrives)
        this.visits = null; // 2D array [y][x] with small integers

        // Raw game configuration (stored for reference)
        this.config = {
            MAP_FILE: null,
            PARCELS_GENERATION_INTERVAL: null,
            PARCELS_MAX: null,
            MOVEMENT_STEPS: null,
            MOVEMENT_DURATION: null,
            AGENTS_OBSERVATION_DISTANCE: null,
            PARCELS_OBSERVATION_DISTANCE: null,
            AGENT_TIMEOUT: null,
            PARCEL_REWARD_AVG: null,
            PARCEL_REWARD_VARIANCE: null,
            PARCEL_DECADING_INTERVAL: null,
            RANDOMLY_MOVING_AGENTS: null,
            RANDOM_AGENT_SPEED: null,
            CLOCK: null,

            LOSS_PER_SECOND: null,
            MOVEMENT_PER_SECOND: null,
            LOSS_PER_MOVEMENT: null
        };
    }

    // Initialize with map configuration
    initMap(width, height, tiles) {
        this.environment.init(width, height, tiles);

        // Initialize visit heatmap
        this.visits = Array.from({ length: height }, () =>
            new Uint16Array(width).fill(0)
        );
    }

    // Update configuration from server
    updateConfig(config) {
        Object.assign(this.config, config);

        // Then calculate derived parameters
        let LOSS_PER_SECOND = 0;
        let MOVEMENT_PER_SECOND = 0;
        let LOSS_PER_MOVEMENT = 0;

        // Calculate decay rate
        if (this.config.PARCEL_DECADING_INTERVAL !== 'infinite') {
            const decaySeconds = parseInt(this.config.PARCEL_DECADING_INTERVAL.slice(0, -1));
            LOSS_PER_SECOND = 1 / decaySeconds;
        }

        // Calculate movement rate
        if (this.config.MOVEMENT_DURATION) {
            MOVEMENT_PER_SECOND = 1000 / this.config.MOVEMENT_DURATION;
            LOSS_PER_MOVEMENT = LOSS_PER_SECOND / MOVEMENT_PER_SECOND;
        }

        // Assign derived parameters
        this.config.LOSS_PER_SECOND = LOSS_PER_SECOND;
        this.config.MOVEMENT_PER_SECOND = MOVEMENT_PER_SECOND;
        this.config.LOSS_PER_MOVEMENT = LOSS_PER_MOVEMENT;
    }

    // Update agent's own position and state
    updateMe(data) {
        this.me.id = data.id;
        this.me.name = data.name;
        this.me.x = data.x;
        this.me.y = data.y;
        this.me.score = data.score || this.me.score;
    }

    // Record a visit to (x,y) for coverage-driven exploration
    noteVisit(x, y) {
        if (!this.visits) return;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (iy >= 0 && iy < this.visits.length && ix >= 0 && ix < this.visits[0].length) {
            const row = this.visits[iy];
            // saturate at 65535 (Uint16)
            if (row[ix] < 0xFFFF) row[ix] += 1;
        }
    }

    // Update parcels from sensing
    updateParcels(parcelsData) {
        const currentTime = Date.now();
        
        for (const parcel of parcelsData) {
            // Update or add parcel
            this.parcels.set(parcel.id, {
                id: parcel.id,
                x: parcel.x,
                y: parcel.y,
                carriedBy: parcel.carriedBy,
                reward: parcel.reward,
                lastSeen: currentTime
            });

            // If carried by me, add to my carried list
            if (parcel.carriedBy === this.me.id) {
                if (!this.me.carriedParcels.find(p => p.id === parcel.id)) {
                    this.me.carriedParcels.push(parcel);
                }
            }
            else {
                // Remove from carried if no longer carried by me
                this.me.carriedParcels = this.me.carriedParcels.filter(p => p.id !== parcel.id);
            }
        }
    }

    // Update other agents
    updateAgents(agentsData) {
        const currentTime = Date.now();
        
        for (const agent of agentsData) {
            if (agent.id === this.me.id) continue;
            
            this.agents.set(agent.id, {
                id: agent.id,
                name: agent.name,
                x: agent.x,
                y: agent.y,
                score: agent.score,
                lastSeen: currentTime
            });
        }
    }

    // Get available (not carried) parcels that are on reachable tiles
    getAvailableParcels() {
        return Array.from(this.parcels.values())
            .filter(p => {
                // Not carried
                if (p.carriedBy) return false;
                
                // Must be visible
                if (!this.isVisible(p.x, p.y)) return false;
                
                // Must be on a reachable tile (or very close to one)
                const roundedX = Math.round(p.x);
                const roundedY = Math.round(p.y);
                
                if (!this.environment.isReachable(roundedX, roundedY)) {
                    // Check if any adjacent tile is reachable
                    const adjacent = [
                        [roundedX + 1, roundedY],
                        [roundedX - 1, roundedY],
                        [roundedX, roundedY + 1],
                        [roundedX, roundedY - 1]
                    ];
                    
                    const hasReachableAdjacent = adjacent.some(([x, y]) => 
                        this.environment.isReachable(x, y)
                    );
                    
                    if (!hasReachableAdjacent) {
                        console.log(`Parcel ${p.id} at (${p.x}, ${p.y}) is not reachable - skipping`);
                        return false;
                    }
                }
                
                // Check if we've failed too many times to reach this parcel
                const attempts = this.failedAttempts.get(p.id) || 0;
                if (attempts >= 3) {
                    console.log(`Parcel ${p.id} has failed ${attempts} times - skipping`);
                    return false;
                }
                
                return true;
            });
    }

    // Mark a failed attempt to reach a parcel
    recordFailedAttempt(parcelId) {
        const current = this.failedAttempts.get(parcelId) || 0;
        this.failedAttempts.set(parcelId, current + 1);
        console.log(`Failed attempt #${current + 1} for parcel ${parcelId}`);
    }

    // Clear failed attempts (e.g., when new parcels spawn)
    clearFailedAttempt(parcelId) {
        this.failedAttempts.delete(parcelId);
    }

    // Clear all failed attempts periodically
    resetFailedAttempts() {
        this.failedAttempts.clear();
    }

    getBestParcelWithUtility() {
        this.checkParcels();

        const availableParcels = this.getAvailableParcels();
        if (availableParcels.length === 0) {
            return { parcel: null, utility: -Infinity };
        }

        let bestParcel = null;
        let bestUtility = -Infinity;

        const currentX = Math.round(this.me.x);
        const currentY = Math.round(this.me.y);

        for (const parcel of availableParcels) {
            const utility = this.calculatePickupUtility(parcel, currentX, currentY);
            
            if (utility > bestUtility) {
                bestUtility = utility;
                bestParcel = parcel;
            }
        }

        return { parcel: bestParcel, utility: bestUtility };
    }

    getBestParcel() {
        this.checkParcels();
        return this.getBestParcelWithUtility().parcel;
    }

    getParcelAt(x, y) {
        this.checkParcels();
        for (let [_, parcel] of this.parcels) {
            if (Math.round(parcel.x) === Math.round(x) && Math.round(parcel.y) === Math.round(y)) {
                return parcel;
            }
        }
        return null;
    } 

    getParcel(id) {
        this.checkParcels();
        if (!this.parcels.has(id)) return null;
        return this.parcels.get(id);
    }

    // Get carried parcels
    getCarriedParcels() {
        this.checkParcels();
        return this.me.carriedParcels;
    }

    // Check if position is within observation distance
    isVisible(x, y) {
        const observationDistance = this.config.PARCELS_OBSERVATION_DISTANCE;
        if (observationDistance === 'infinite') return true;

        const distance = manhattanDistance(this.me.x, this.me.y, x, y);
        return distance < observationDistance;
    }

    removeParcel(id) {
        this.parcels.delete(id);
        this.me.carriedParcels = this.me.carriedParcels.filter(p => p.id !== id);
        this.clearFailedAttempt(id); // Clear failed attempts when parcel is removed
    }

    removeParcelFromCarried(id) {
        this.me.carriedParcels = this.me.carriedParcels.filter(p => p.id !== id);
    }

    checkParcels() {
        if (this.config.LOSS_PER_SECOND === 0) return;

        const now = Date.now();
        for (const [id, parcel] of this.parcels) {
            const elapsedTime = now - parcel.lastSeen;
            const lost = (elapsedTime / 1000) * this.config.LOSS_PER_SECOND;

            if (parcel.reward - lost <= 0) {
                if(this.me.carriedParcels && this.me.carriedParcels.some(p => p.id === id)) {
                    this.removeParcelFromCarried(id);
                }
                this.removeParcel(id);
            }
        }
    }

    shouldDeliver() {
        if (this.me.carriedParcels.length === 0) return false;

        const currentX = Math.round(this.me.x);
        const currentY = Math.round(this.me.y);

        // If at delivery zone, deliver immediately
        if (this.environment.isDelivery(currentX, currentY)) {
            return true;
        }

        // Calculate utility of delivering now vs picking up more parcels
        const deliverUtility = this.calculateDeliverUtility();
        const { utility: pickupUtility } = this.getBestParcelWithUtility();

        // Deliver if it's better than picking up more parcels
        return deliverUtility > pickupUtility;
    }

    // Calculate utility of delivering carried parcels
    calculateDeliverUtility() {
        if (this.me.carriedParcels.length === 0) return -Infinity;

        const currentX = Math.round(this.me.x);
        const currentY = Math.round(this.me.y);

        // If at delivery zone, infinite utility
        if (this.environment.isDelivery(currentX, currentY)) {
            return Infinity;
        }

        const totalCarriedReward = this.me.carriedParcels.reduce((sum, p) => sum + p.reward, 0);
        const closestDelivery = this.environment.getClosestDeliveryTile(currentX, currentY);
        if (!closestDelivery) return -Infinity;

        const distanceToDelivery = manhattanDistance(currentX, currentY, closestDelivery.x, closestDelivery.y);

        const numCarried = this.me.carriedParcels.length;
        const lossPerMovement = this.config.LOSS_PER_MOVEMENT;

        const utility = totalCarriedReward - (distanceToDelivery * lossPerMovement * numCarried);
        return utility;
    }

    // Calculate utility of picking up a specific parcel
    calculatePickupUtility(parcel, fromX, fromY) {
        // If parcel at current location, infinite utility
        if (Math.round(parcel.x) === fromX && Math.round(parcel.y) === fromY) {
            return Infinity;
        }

        const newReward = parcel.reward;
        const totalCarriedReward = this.me.carriedParcels.reduce((sum, p) => sum + p.reward, 0);
        const distanceToParcel = manhattanDistance(fromX, fromY, parcel.x, parcel.y);
        
        const closestDelivery = this.environment.getClosestDeliveryTile(parcel.x, parcel.y);
        if (!closestDelivery) return -Infinity;

        const distanceToDelivery = manhattanDistance(parcel.x, parcel.y, closestDelivery.x, closestDelivery.y);
        const numAfterPickup = this.me.carriedParcels.length + 1;
        const lossPerMovement = this.config.LOSS_PER_MOVEMENT;

        const utility = (newReward + totalCarriedReward) - ((distanceToParcel + distanceToDelivery) * lossPerMovement * numAfterPickup);
        return utility;
    }

    isBlocked(x, y) {
        // Keep as-is (not used in changes)
        if (!this.belief?.me?.id || !this.belief?.agents) return false;
        return this.belief.agents.some(agent =>
            agent.id !== this.belief.me.id &&
            Math.floor(agent.x) === x &&
            Math.floor(agent.y) === y
        );
    }
}
