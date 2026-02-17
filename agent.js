import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { Beliefs } from "./Beliefs/beliefs.js";
import { Pathfinding } from "./BDI - plans/pathfinding.js";
import { Intention } from "./BDI - plans/intention.js";
import { Coordination } from "./Collaboration/coordination.js";
import { CollectorPlan, CourierPlan } from "./BDI - plans/handover.js";

import { Pickup } from "./BDI - plans/pickup.js";
import { Deliver } from "./BDI - plans/deliver.js";
import { Explore } from "./BDI - plans/explore.js";
import { PDDLPlan } from "./PDDL/pddl_plan.js";

export class DeliverooAgent {
    constructor(host, token, enableCoordination = false, usePDDL = false) {
        // Network client for Deliveroo simulator
        this.client = new DeliverooApi(host, token);

        // World model + algorithms operating on it
        this.beliefs = new Beliefs();
        this.pathfinding = new Pathfinding(this.beliefs);

        // Readiness flags (we only act after both are available)
        this.mapReady = false;
        this.configReady = false;

        // Plan instances and current running intention
        this.plans = null;
        this.currentIntention = null;

        // Optional partner coordination (handshake + role/zone logic)
        this.enableCoordination = enableCoordination;
        this.coordination = null;

        // If handover mode is detected, this overrides normal pickup/deliver/explore
        this.handoverPlan = null;

        // Ensure coordination mode detection happens only once per run
        this.coordinationModeDetected = false;

        // Optional PDDL planning
        this.pddlPlan = null;
        this.usePDDL = usePDDL;

        this.running = false;

        this.lastParcelShare = 0;
        this.lastAgentShare = 0;

        console.log(`[Agent] Created | coordination: ${enableCoordination} | PDDL: ${usePDDL}`);
    }

    async start() {
        this.setupListeners();

        // Create coordination module if enabled
        if (this.enableCoordination) {
            this.coordination = new Coordination(this.client, this.beliefs, this.pathfinding);
        }

        // Start decision loop
        this.running = true;
        await this.loop();
    }

    setupListeners() {
        // Server configuration (movement duration, observation ranges, decay, etc.)
        this.client.onConfig((gameConfig) => {
            console.log(` [Agent] - CONFIG received`);
            this.beliefs.initConfig(gameConfig);
            this.configReady = true;

            // Some coordination logic depends on both config + map + id
            this.checkCoordinationReady();

            // Create plans once map+config exist
            this.ensurePlans();
        });

        // Static map definition (grid + tile types)
        this.client.onMap((width, height, tiles) => {
            console.log(` [Agent] - MAP received: ${width}x${height}`);
            this.beliefs.environment.init(width, height, tiles);
            this.mapReady = true;

            this.checkCoordinationReady();
            this.ensurePlans();
        });

        // Agent identity + initial position (needed for coordination)
        this.client.onYou((me) => {
            this.beliefs.id = me.id;
            this.beliefs.x = me.x;
            this.beliefs.y = me.y;
            this.beliefs.score = me.score;

            this.checkCoordinationReady();
        });

        // Perception: parcels currently sensed (may be partial / within range)
        this.client.onParcelsSensing((parcels) => {
            this.beliefs.updateParcels(parcels);
            this.shareInformationIfNeeded();
        });

        // Perception: agents currently sensed (excluding self)
        this.client.onAgentsSensing((agents) => {
            this.beliefs.updateAgents(agents);
            this.shareInformationIfNeeded();
        });
    }

    checkCoordinationReady() {
        // Only relevant when coordination is enabled and initialized
        if (!this.enableCoordination || !this.coordination) return;

        // Start handshake once we have map+config+id; keep trying until partner is found
        if (this.mapReady && this.configReady && this.beliefs.id && !this.beliefs.hasPartner()) {
            console.log('[Agent] - Starting partner discovery...');
            this.coordination.startPartnerDiscovery();
            return;
        }

        // Once partnership is confirmed, detect mode ONE time:
        // - HANDOVER if bottleneck exists
        // - otherwise NORMAL (zone partition)
        if (this.beliefs.hasPartner() &&
            this.mapReady &&
            this.configReady &&
            this.beliefs.id &&
            !this.coordinationModeDetected) {

            console.log('[Agent] - Detecting coordination mode...');
            this.coordination.detectCoordinationMode();
            this.coordinationModeDetected = true;

            // If handover mode is active, create the proper role-specific plan
            this.setupHandoverPlan();

            // If not handover, assign map partitions (zones) if not already set
            if (!this.coordination.isHandoverMode() && !this.beliefs.myArea) {
                this.partitionMap();
            }
        }
    }

    setupHandoverPlan() {
        // Create handover plan only once
        if (this.handoverPlan) return;

        // Wait until coordination has enough info (mode + role decided)
        const handoverConfig = this.coordination.getHandoverConfig();
        if (!handoverConfig) return;

        console.log(`[Agent] - Setting up handover plan for role: ${handoverConfig.role}`);

        // Collector patrols spawns and drops at handover
        if (handoverConfig.role === 'COLLECTOR') {
            this.handoverPlan = new CollectorPlan(
                this.beliefs,
                this.pathfinding,
                handoverConfig.spawnTile,
                handoverConfig.handoverTile,
                this.coordination
            );
        }
        // Courier waits near handover, picks up from handover, then delivers
        else if (handoverConfig.role === 'COURIER') {
            this.handoverPlan = new CourierPlan(
                this.beliefs,
                this.pathfinding,
                handoverConfig.deliveryTile,
                handoverConfig.handoverTile,
                this.coordination
            );
        }
    }

    partitionMap() {
        // Compute myArea based on environment partition + id tie-breaker
        console.log(`[Agent] - Partitioning map with partner ${this.beliefs.partnerId}`);
        this.beliefs.getAssignedArea();
    }

    ensurePlans() {
        // Instantiate plans only after we have a map and config
        if (!this.mapReady || !this.configReady) return;
        if (this.plans) return;

        // A*-based plans (baseline)
        this.plans = {
            pickup: new Pickup(this.beliefs, this.pathfinding, this.coordination),
            deliver: new Deliver(this.beliefs, this.pathfinding, this.coordination),
            explore: new Explore(this.beliefs, this.pathfinding, this.coordination),
        };

        // PDDL plan is optional (covers pickup+delivery in one plan)
        if (this.usePDDL) {
            this.pddlPlan = new PDDLPlan(this.beliefs, this.pathfinding, this.coordination);
            console.log('[Agent] PDDL planning enabled');
        }
    }

    isReady() {
        // In coordination mode we require a confirmed partner before acting
        if (this.enableCoordination && this.coordination) {
            return this.mapReady &&
                   this.configReady &&
                   this.plans &&
                   this.beliefs.id !== null &&
                   this.beliefs.hasPartner();
        }

        return this.mapReady && this.configReady && this.plans && this.beliefs.id !== null;
    }

    async shareInformationIfNeeded() {
        // Share only if partnered (otherwise emits are pointless)
        if (!this.coordination || !this.beliefs.hasPartner()) return;

        const now = Date.now();

        // Broadcast parcel list at low frequency (avoid message spam)
        if (now - this.lastParcelShare > 3000) {
            const parcels = this.beliefs.getAvailableParcels();
            if (parcels.length > 0) {
                await this.coordination.shareParcels(parcels);
                this.lastParcelShare = now;
            }
        }

        // Broadcast agent positions at low frequency
        if (now - this.lastAgentShare > 3000) {
            if (this.beliefs.agents.length > 0) {
                await this.coordination.shareAgents(this.beliefs.agents);
                this.lastAgentShare = now;
            }
        }
    }

    async sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    pickCandidateIntention() {
        // Highest priority: if handover mode is active, run role-specific plan only
        if (this.handoverPlan) {
            console.log('[Agent] Using handover plan');
            return new Intention(this.client, this.beliefs, "handover", this.handoverPlan, 10);
        }

        // PDDL branch: if enabled and available, it can start/continue a long action sequence
        if (this.usePDDL && this.pddlPlan) {

            // Disable PDDL for the rest of the session if it fails repeatedly
            if (this.pddlPlan.shouldAbort()) {
                console.log('[Agent] PDDL failed too many times, falling back to A*');
                this.usePDDL = false;
            }
            // If PDDL is already busy (solver running or queue non-empty), keep it as intention
            else if (this.pddlPlan.isExecuting()) {
                return new Intention(this.client, this.beliefs, "pddl", this.pddlPlan, 4);
            }
            // Start a new PDDL plan only when not carrying a parcel
            else if (!this.beliefs.hasParcel()) {
                const pos = { x: Math.floor(this.beliefs.x), y: Math.floor(this.beliefs.y) };
                const candidate = this.pddlPlan.selectBestParcel(pos);

                // If there is a profitable parcel, reset PDDL plan to IDLE and let it start
                if (candidate) {
                    this.pddlPlan.prepareForNewPlan();
                    console.log(`[Agent] Starting PDDL plan for parcel ${candidate.id}`);
                    return new Intention(this.client, this.beliefs, "pddl", this.pddlPlan, 4);
                }
            }
        }

        // A* deliver: if we are carrying something and PDDL isn't running
        if (this.beliefs.hasParcel()) {
            // Reset deliver failure counter when switching into deliver
            if (!this.currentIntention || this.currentIntention.goal !== "deliver") {
                this.plans.deliver.resetFailures();
            }
            return new Intention(this.client, this.beliefs, "deliver", this.plans.deliver, 3);
        }

        // A* pickup: continue ongoing pickup intention unless we decide to yield to partner
        if (this.currentIntention &&
            this.currentIntention.goal === "pickup" &&
            !this.currentIntention.isStopped() &&
            !this.currentIntention.isCompleted()) {

            // In coordination mode: yield if partner has stronger claim on the same parcel
            if (this.coordination && this.coordination.shouldYieldIntention()) {
                console.log('[Agent] Yielding pickup due to intention conflict');
                this.currentIntention.stop();
                this.plans.pickup.resetFailures();
                this.coordination.clearIntention();
            } else {
                return this.currentIntention;
            }
        }

        // If we are starting a new pickup attempt, reset pickup failure counter
        if (!this.currentIntention || this.currentIntention.goal !== "pickup") {
            this.plans.pickup.resetFailures();
        }

        // Let pickup plan choose/update its target parcel
        this.plans.pickup.updateTarget();

        // Announce selected target to partner for conflict detection / yielding
        if (this.coordination && this.plans.pickup.getTargetParcel()) {
            const target = this.plans.pickup.getTargetParcel();
            this.coordination.announceIntention({
                parcelId: target.id,
                x: target.x,
                y: target.y,
                utility: this.plans.pickup.calculateUtility(
                    Math.floor(this.beliefs.x),
                    Math.floor(this.beliefs.y),
                    target
                )
            });
        }

        // If pickup found a parcel, create pickup intention
        if (this.plans.pickup.getTargetParcel()) {
            return new Intention(this.client, this.beliefs, "pickup", this.plans.pickup, 2);
        }

        // Explore fallback: roam to discover parcels / keep agent moving
        if (!this.currentIntention || this.currentIntention.goal !== "explore") {
            this.plans.explore.resetFailures();
        }
        return new Intention(this.client, this.beliefs, "explore", this.plans.explore, 1);
    }

    async loop() {
        while (this.running) {

            // Wait until prerequisites are ready (prevents acting on incomplete state)
            if (!this.isReady()) {
                await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                continue;
            }

            // If collision protocol is active, sometimes we should pause instead of moving
            if (this.coordination && this.coordination.isInCollision()) {
                const state = this.coordination.collisionState;

                // Initiator: wait for partner to report MOVED
                if (state.initiator && state.waitingFor === 'MOVED') {
                    console.log('[Agent] - Waiting for partner to move.');
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                    continue;
                }

                // Non-initiator: partner is handling the protocol, do not interfere
                if (!state.initiator && state.waitingFor === 'END') {
                    console.log('[Agent] - Partner handling collision, waiting.');
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                    continue;
                }

                // Initiator: collision has been resolved and we can proceed
                if (state.initiator && state.phase === 'proceeding') {
                    console.log('[Agent] - Collision resolved, proceeding with action.');
                }
            }

            // Choose best intention for current tick (may differ from current intention)
            const candidate = this.pickCandidateIntention();

            // Start first intention or preempt if candidate has higher priority
            if (!this.currentIntention) {
                this.currentIntention = candidate;
            }
            else if (this.currentIntention !== candidate && this.currentIntention.canBePreemptedBy(candidate)) {
                this.currentIntention.stop();
                this.currentIntention = candidate;
            }

            try {
                // Snapshot before action (used for basic “did it work?” validation logs)
                const before_x = Math.floor(this.beliefs.x);
                const before_y = Math.floor(this.beliefs.y);
                const beforeHasParcel = this.beliefs.hasParcel();
                const beforeCarried = this.beliefs.parcels.filter(p => p.carriedBy === this.beliefs.id).length;

                // Execute one step of the current intention (may return null = wait/no-op)
                const executed = await this.currentIntention.step();

                // Mark completion / cleanup if intention finished
                this.currentIntention.refreshCompletion();
                if (this.currentIntention.isCompleted()) {
                    console.log(` Agent - ${this.currentIntention.goal} completed`);
                    this.currentIntention = null;

                    // If we were collision initiator and got completion, end protocol
                    if (this.coordination &&
                        this.coordination.isInCollision() &&
                        this.coordination.collisionState.initiator) {
                        await this.coordination.endCollision();
                    }

                    continue;
                }

                // If intention was stopped (preempted/aborted), clear it
                if (this.currentIntention.isStopped()) {
                    console.log(` Agent - ${this.currentIntention.goal} stopped`);
                    this.currentIntention = null;
                    continue;
                }

                // If plan produced no action, handle failure/backoff and retry next tick
                if (!executed) {
                    console.log("Agent - Reason:", this.currentIntention.plan.lastFailureReason, "Fails:", this.currentIntention.plan.failedAttempts);

                    // Auto-discard intention if plan exceeded allowed failures
                    if (this.currentIntention && this.currentIntention.plan && this.currentIntention.plan.shouldAbort()) {
                        console.log(` Agent - ${this.currentIntention.goal} discarded (too many failures)`);
                        this.currentIntention.stop();
                        this.currentIntention = null;
                    }

                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                    continue;
                }

                // Action-specific post-checks (mainly for debugging and collision protocol)
                const act = executed;
                const type = act.action;

                if (type === "up" || type === "down" || type === "left" || type === "right") {
                    console.log(`Action: ${type}`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);

                    const after_x = Math.floor(this.beliefs.x);
                    const after_y = Math.floor(this.beliefs.y);

                    // Detect if position actually changed (can reveal collisions / blocked moves)
                    const ok = !(after_x === before_x && after_y === before_y);
                    console.log(ok ? ` Moved successfully` : ` Position NOT updated!`);

                    // If collision initiator was waiting to proceed, end protocol after a successful move
                    if (ok && this.coordination &&
                        this.coordination.isInCollision() &&
                        this.coordination.collisionState.initiator &&
                        this.coordination.collisionState.phase === 'proceeding') {
                        await this.coordination.endCollision();
                    }
                }
                else if (type === "pickup") {
                    console.log(`Action: pickup`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);

                    const afterHasParcel = this.beliefs.hasParcel();
                    const afterCarried = this.beliefs.parcels.filter(p => p.carriedBy === this.beliefs.id).length;

                    // Pickup is considered ok if carried count increases or we transition to hasParcel=true
                    const ok = (afterCarried > beforeCarried) || (!beforeHasParcel && afterHasParcel);
                    console.log(ok ? ` Pickup OK` : ` Pickup FAILED`);
                }
                else if (type === "putdown") {
                    console.log(`Action: putdown`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);

                    const afterHasParcel = this.beliefs.hasParcel();
                    const afterCarried = this.beliefs.parcels.filter(p => p.carriedBy === this.beliefs.id).length;

                    // Putdown ok if carried count decreases or we transition to hasParcel=false
                    const ok = (afterCarried < beforeCarried) || (beforeHasParcel && !afterHasParcel);
                    console.log(ok ? ` Putdown OK` : ` Putdown FAILED`);
                }
                else {
                    // Any other action types (if added later) still respect movement duration
                    console.log(`Action: ${type}`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                }

                // Safety: if current plan exceeded failures after this step, discard it
                if (this.currentIntention && this.currentIntention.plan && this.currentIntention.plan.shouldAbort()) {
                    console.log(` ${this.currentIntention.goal} discarded (too many failures)`);
                    this.currentIntention.stop();
                    this.currentIntention = null;
                    continue;
                }

                // Refresh completion again after action effects have propagated into beliefs
                this.currentIntention.refreshCompletion();
                if (this.currentIntention.isCompleted()) {
                    console.log(` ${this.currentIntention.goal} completed`);
                    this.currentIntention = null;
                }
            }
            catch (e) {
                // Hard failure: stop current intention and retry next tick
                console.error(`\n ERROR: ${e.message || e}`);
                if (this.currentIntention) this.currentIntention.stop();
                this.currentIntention = null;
                await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
            }
        }
    }

    stop() {
        this.running = false;

        if (this.currentIntention) this.currentIntention.stop();
        this.currentIntention = null;

        if (this.coordination) {
            this.coordination.destroy();
        }
    }
}
