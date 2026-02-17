import { Environment } from './environment.js';
import { manhattanDistance } from "../Utils/utils.js";

export class Beliefs {
    constructor() {
        // World model (map, tiles, partitions, etc.)
        this.environment = new Environment();

        // Self state (updated from server)
        this.id = null;
        this.x = -1;
        this.y = -1;
        this.score = 0;

        // Observations (updated from server)
        this.agents = [];   // other agents only (self filtered out)
        this.parcels = [];  // parcels in observation range (as reported by server)

        // Coordination state (partner + assigned zone)
        this.partnerId = null;
        this.partnerPosition = null;
        this.partnerConfirmed = false;
        this.myArea = null; // list of tiles (e.g., spawner tiles) assigned to this agent

        // Configuration values:
        // - some are provided by server
        // - some are agent-specific defaults
        // - some are derived/computed for convenience (loss per move, etc.)
        this.config =
        {
            // Server-provided config
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

            // Agent-specific config (fallback defaults in initConfig)
            BAN_DURATION: null,
            MAX_FAILED_ATTEMPTS: null,
            PARTITION_LIMIT: null,
            REFINEMENT_ROUNDS: null,
            MAX_PARCELS_DETOUR: null,
            DETOUR_UTILITY_THRESHOLD: null,
            MAX_COLLISION_RETRIES: null,
            MAX_STUCK_TICKS: null,

            // Computed values (filled in initConfig)
            LOSS_PER_SECOND: null,
            MOVEMENT_PER_SECOND: null,
            LOSS_PER_MOVEMENT: null
        };
    }

    updateParcels(parcels) {
        // Replace parcel beliefs with the latest snapshot and stamp with local lastSeen time
        const currentTime = Date.now();

        this.parcels = parcels.map(
            parcel => (
                {
                    id: parcel.id,
                    x: parcel.x,
                    y: parcel.y,
                    reward: parcel.reward,
                    carriedBy: parcel.carriedBy,
                    lastSeen: currentTime
                }
            )
        );
    }

    updateAgents(agents) {
        // Track other agents (self filtered out) and stamp lastSeen for recency checks
        const currentTime = Date.now();

        this.agents = agents
            .filter(agent => agent.id !== this.id)
            .map(agent => (
                {
                    id: agent.id,
                    name: agent.name,
                    x: agent.x,
                    y: agent.y,
                    score: agent.score,
                    lastSeen: currentTime
                }
            ));
    }

    setPartner(partner) {
        // Lock-in partner information for coordination logic
        this.partnerId = partner.id;
        this.partnerPosition = { x: partner.x, y: partner.y };
        this.partnerConfirmed = true;
        console.log(`[Beliefs] Partner set: ${partner.id}`);
    }

    hasPartner() {
        // Partner is considered valid only after explicit confirmation
        return this.partnerConfirmed && this.partnerId !== null;
    }

    getPartner() {
        if (!this.partnerId) return null;
        return this.agents.find(a => a.id === this.partnerId);
    }

    clearPartner() {
        this.partnerId = null;
        this.partnerConfirmed = false;
        this.myArea = null;
    }

    getAssignedArea() {
        // Assign a zone only when coordination is active
        if (!this.hasPartner()) {
            console.log('[Beliefs] No partner, skipping area assignment');
            return;
        }

        // Partition spawner tiles into two clusters
        const partition = this.environment.partitionMap(this.config);

        // Deterministic assignment: lower id takes first cluster, higher id takes second
        if (this.id < this.partnerId) {
            this.myArea = partition.firstCluster;
            console.log(`[Beliefs] Assigned to Zone A: ${this.myArea.length} spawner tiles`);
        }
        else {
            this.myArea = partition.secondCluster;
            console.log(`[Beliefs] Assigned to Zone B: ${this.myArea.length} spawner tiles`);
        }
    }

    isVisible(target_x, target_y) {
        return manhattanDistance(this.x, this.y, target_x, target_y) <= this.config.PARCELS_OBSERVATION_DISTANCE;
    }

    getAvailableParcels() {
        return this.parcels.filter(parcel => !parcel.carriedBy);
    }

    getCarriedParcels() {
        return this.parcels.filter(parcel => parcel.carriedBy === this.id);
    }

    hasParcel() {
        return this.parcels.some(parcel => parcel.carriedBy === this.id);
    }

    isBlocked(target_x, target_y) {
        // A tile is blocked if any other agent currently occupies it (based on latest beliefs)
        const agents = this.agents;
        if (!agents) return false;

        return agents.some(agent =>
            agent.id !== this.id &&
            Math.floor(agent.x) === target_x &&
            Math.floor(agent.y) === target_y
        );
    }

    initConfig(config) {
        // Merge server config into local config object
        Object.assign(this.config, config);

        // Defaults for agent-specific parameters
        if (this.config.BAN_DURATION == null) this.config.BAN_DURATION = 20;
        if (this.config.MAX_FAILED_ATTEMPTS == null) this.config.MAX_FAILED_ATTEMPTS = 3;
        if (this.config.PARTITION_LIMIT == null) this.config.PARTITION_LIMIT = 50;
        if (this.config.REFINEMENT_ROUNDS == null) this.config.REFINEMENT_ROUNDS = 3;
        if (this.config.MAX_PARCELS_DETOUR == null) this.config.MAX_PARCELS_DETOUR = 10;
        if (this.config.DETOUR_UTILITY_THRESHOLD == null) this.config.DETOUR_UTILITY_THRESHOLD = 3;
        if (this.config.MAX_COLLISION_RETRIES == null) this.config.MAX_COLLISION_RETRIES = 3;
        if (this.config.PDDL_SOLVER_TIMEOUT == null) this.config.PDDL_SOLVER_TIMEOUT = 30000;
        if (this.config.MAX_STUCK_TICKS == null) this.config.MAX_STUCK_TICKS = 3;

        // Derive convenience values for reward decay and movement “cost”
        let LOSS_PER_SECOND = 0;
        let MOVEMENT_PER_SECOND = 0;
        let LOSS_PER_MOVEMENT = 0;

        // If parcels decay, compute how much reward is lost per second
        if (this.config.PARCEL_DECADING_INTERVAL !== 'infinite') {
            const decaySeconds = this.config.PARCEL_DECADING_INTERVAL.slice(0, -1);
            LOSS_PER_SECOND = 1 / decaySeconds;
        }

        // Convert movement duration into moves per second and per-move reward loss
        if (this.config.MOVEMENT_DURATION) {
            MOVEMENT_PER_SECOND = 1000 / this.config.MOVEMENT_DURATION;
            LOSS_PER_MOVEMENT = LOSS_PER_SECOND / MOVEMENT_PER_SECOND;
        }

        this.config.LOSS_PER_SECOND = LOSS_PER_SECOND;
        this.config.MOVEMENT_PER_SECOND = MOVEMENT_PER_SECOND;
        this.config.LOSS_PER_MOVEMENT = LOSS_PER_MOVEMENT;
    }
}
