import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { Beliefs } from "./Belief/beliefs.js";
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
        this.client = new DeliverooApi(host, token);

        this.beliefs = new Beliefs();
        this.pathfinding = new Pathfinding(this.beliefs); 

        this.mapReady = false;
        this.configReady = false;

        this.plans = null;
        this.currentIntention = null;
        
        this.enableCoordination = enableCoordination;
        this.coordination = null;
        this.handoverPlan = null;
        this.coordinationModeDetected = false;  // ✅ Add flag

        this.pddlPlan = null;
        this.usePDDL = usePDDL;     // simple boolean: enable/disable PDDL planning

        this.running = false;
        
        // Information sharing timers
        this.lastParcelShare = 0;
        this.lastAgentShare = 0;

        console.log(`[Agent] Created | coordination: ${enableCoordination} | PDDL: ${usePDDL}`);
    }

    async start() {
        this.setupListeners();
        
        if (this.enableCoordination) {
            this.coordination = new Coordination(this.client, this.beliefs, this.pathfinding);
        }
        
        this.running = true;
        await this.loop();
    }

    setupListeners() {
        this.client.onConfig((gameConfig) => {
            console.log(` [Agent] - CONFIG received`);
            this.beliefs.initConfig(gameConfig);
            this.configReady = true;
            this.checkCoordinationReady();
            this.ensurePlans();
        });

        this.client.onMap((width, height, tiles) => {
            console.log(` [Agent] - MAP received: ${width}x${height}`);
            this.beliefs.environment.init(width, height, tiles);
            this.mapReady = true;
            this.checkCoordinationReady();
            this.ensurePlans();
        });

        this.client.onYou((me) => {
            this.beliefs.id = me.id;
            this.beliefs.x = me.x;
            this.beliefs.y = me.y;
            this.beliefs.score = me.score;
            this.checkCoordinationReady();
        });

        this.client.onParcelsSensing((parcels) => {
            this.beliefs.updateParcels(parcels);
            this.shareInformationIfNeeded();
        });

        this.client.onAgentsSensing((agents) => {
            this.beliefs.updateAgents(agents);
            this.shareInformationIfNeeded();
        });
    }

    checkCoordinationReady() {
        if (!this.enableCoordination || !this.coordination) return;
        
        // Start partner discovery
        if (this.mapReady && this.configReady && this.beliefs.id && !this.beliefs.hasPartner()) {
            console.log('[Agent] - Starting partner discovery...');
            this.coordination.startPartnerDiscovery();
            return;
        }
        
        // Detect coordination mode ONCE when partnership is ready
        if (this.beliefs.hasPartner() && this.mapReady && this.configReady && this.beliefs.id && !this.coordinationModeDetected) {
            console.log('[Agent] - Detecting coordination mode...');
            this.coordination.detectCoordinationMode();
            this.coordinationModeDetected = true;
            
            this.setupHandoverPlan();
            
            if (!this.coordination.isHandoverMode() && !this.beliefs.myArea) {
                this.partitionMap();
            }
        }
    }

    setupHandoverPlan() {
        if (this.handoverPlan) return;
        
        const handoverConfig = this.coordination.getHandoverConfig();
        if (!handoverConfig) return;
        
        console.log(`[Agent] - Setting up handover plan for role: ${handoverConfig.role}`);
        
        if (handoverConfig.role === 'COLLECTOR') {
            this.handoverPlan = new CollectorPlan(
                this.beliefs,
                this.pathfinding,
                handoverConfig.spawnTile,
                handoverConfig.handoverTile,
                this.coordination
            );
        } 
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
        console.log(`[Agent] - Partitioning map with partner ${this.beliefs.partnerId}`);
        this.beliefs.getAssignedArea();
    }

    ensurePlans() {
        if (!this.mapReady || !this.configReady) return;
        if (this.plans) return;

        this.plans = {
            pickup: new Pickup(this.beliefs, this.pathfinding, this.coordination),
            deliver: new Deliver(this.beliefs, this.pathfinding, this.coordination),
            explore: new Explore(this.beliefs, this.pathfinding, this.coordination),
        };

        // Create PDDLPlan instance only if the flag is on
        if (this.usePDDL) {
            this.pddlPlan = new PDDLPlan(this.beliefs, this.pathfinding, this.coordination);
            console.log('[Agent] PDDL planning enabled');
        }
    }

    isReady() {
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
        if (!this.coordination || !this.beliefs.hasPartner()) return;
        
        const now = Date.now();
        
        if (now - this.lastParcelShare > 3000) {
            const parcels = this.beliefs.getAvailableParcels();
            if (parcels.length > 0) {
                await this.coordination.shareParcels(parcels);
                this.lastParcelShare = now;
            }
        }
        
        if (now - this.lastAgentShare > 5000) {
            if (this.beliefs.agents.length > 0) {
                await this.coordination.shareAgents(this.beliefs.agents);
                this.lastAgentShare = now;
            }
        }
    }

    async sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  INTENTION SELECTION — this is where PDDL vs A* is decided
    // ═════════════════════════════════════════════════════════════════════════
    //
    //  Priority order:
    //
    //    10  Handover plan     (if handover mode detected)
    //     4  PDDL plan         (if usePDDL and plan is executing or can start)
    //     3  Deliver via A*    (if carrying parcels, fallback when no PDDL)
    //     2  Pickup via A*     (if parcel available, fallback when no PDDL)
    //     1  Explore via A*    (default when nothing else to do)
    //
    //  The PDDL plan covers BOTH pickup and delivery in one action sequence,
    //  so when it is executing, it must NOT be interrupted by Deliver or
    //  Pickup — even after the agent picks up the parcel mid-plan.
    //
    // ═════════════════════════════════════════════════════════════════════════

    pickCandidateIntention() {

        // ── 1. HANDOVER MODE — always highest priority ──────────────────
        if (this.handoverPlan) {
            console.log('[Agent] Using handover plan');
            return new Intention(this.client, this.beliefs, "handover", this.handoverPlan, 10);
        }
        
        // ── 2. PDDL PLAN ───────────────────────────────────────────────
        if (this.usePDDL && this.pddlPlan) {

            // 2a. If PDDL has failed too many times, disable it for this
            //     session and fall through to A*-based plans permanently.
            if (this.pddlPlan.shouldAbort()) {
                console.log('[Agent] PDDL failed too many times, falling back to A*');
                this.usePDDL = false;
                // fall through to A* below
            }
            // 2b. Continue an active PDDL plan (solver running or actions queued).
            //     This check comes BEFORE hasParcel(), so a PDDL plan that has
            //     already picked up the parcel will NOT be preempted by A* Deliver.
            else if (this.pddlPlan.isExecuting()) {
                return new Intention(this.client, this.beliefs, "pddl", this.pddlPlan, 4);
            }
            // 2c. Start a new PDDL plan — only when not carrying a parcel.
            //     (If carrying, we missed the PDDL window; fall through to A* Deliver.)
            //
            //     We call prepareForNewPlan() here to put the plan back into IDLE
            //     state (started=false) while keeping the failure counter.
            //     This is safe because we already know
            //     isExecuting()=false (section 2b didn't match), so there is
            //     no in-flight solver call to corrupt.
            else if (!this.beliefs.hasParcel()) {
                const pos = { x: Math.floor(this.beliefs.x), y: Math.floor(this.beliefs.y) };
                const candidate = this.pddlPlan.selectBestParcel(pos);
                if (candidate) {
                    this.pddlPlan.prepareForNewPlan();   // DONE → IDLE (keeps failure count)
                    console.log(`[Agent] Starting PDDL plan for parcel ${candidate.id}`);
                    return new Intention(this.client, this.beliefs, "pddl", this.pddlPlan, 4);
                }
                // No profitable parcel → fall through to A*-based plans
            }
        }
        
        // ── 3. A*-BASED DELIVER — carrying parcels, no active PDDL plan ─
        if (this.beliefs.hasParcel()) {
            if (!this.currentIntention || this.currentIntention.goal !== "deliver") {
                this.plans.deliver.resetFailures();
            }
            return new Intention(this.client, this.beliefs, "deliver", this.plans.deliver, 3);
        }

        // ── 4. A*-BASED PICKUP — no parcels carried, PDDL didn't fire ───
        if (this.currentIntention && 
            this.currentIntention.goal === "pickup" && 
            !this.currentIntention.isStopped() &&
            !this.currentIntention.isCompleted()) {
            
            if (this.coordination && this.coordination.shouldYieldIntention()) {
                console.log('[Agent] Yielding pickup due to intention conflict');
                this.currentIntention.stop();
                this.plans.pickup.resetFailures();
                this.coordination.clearIntention();
            } else {
                return this.currentIntention;
            }
        }

        if (!this.currentIntention || this.currentIntention.goal !== "pickup") {
            this.plans.pickup.resetFailures();
        }
        
        this.plans.pickup.updateTarget();
        
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
        
        if (this.plans.pickup.getTargetParcel()) {
            return new Intention(this.client, this.beliefs, "pickup", this.plans.pickup, 2);
        }

        // ── 5. EXPLORE — nothing else to do ─────────────────────────────
        if (!this.currentIntention || this.currentIntention.goal !== "explore") {
            this.plans.explore.resetFailures();
        }
        return new Intention(this.client, this.beliefs, "explore", this.plans.explore, 1);
    }

    async loop() {
        while (this.running) {

            if (!this.isReady()) {
                await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                continue;
            }

            if (this.coordination && this.coordination.isInCollision()) {
                const state = this.coordination.collisionState;
                
                if (state.initiator && state.waitingFor === 'MOVED') {
                    console.log('[Agent] - Waiting for partner to move.');
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                    continue;
                }
                
                if (!state.initiator && state.waitingFor === 'END') {
                    console.log('[Agent] - Partner handling collision, waiting.');
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                    continue;
                }
                
                if (state.initiator && state.phase === 'proceeding') {
                    console.log('[Agent] - Collision resolved, proceeding with action.');
                }
            }

            const candidate = this.pickCandidateIntention();

            if (!this.currentIntention) {
                this.currentIntention = candidate;
            } 
            else if (this.currentIntention !== candidate && this.currentIntention.canBePreemptedBy(candidate)) {
                this.currentIntention.stop();
                this.currentIntention = candidate;
            }

            try {
                const before_x = Math.floor(this.beliefs.x);
                const before_y = Math.floor(this.beliefs.y);
                const beforeHasParcel = this.beliefs.hasParcel();
                const beforeCarried = this.beliefs.parcels.filter(p => p.carriedBy === this.beliefs.id).length;

                const executed = await this.currentIntention.step();

                this.currentIntention.refreshCompletion();
                if (this.currentIntention.isCompleted()) {
                    console.log(` Agent - ${this.currentIntention.goal} completed`);
                    this.currentIntention = null;
                    
                    if (this.coordination && 
                        this.coordination.isInCollision() && 
                        this.coordination.collisionState.initiator) {
                        await this.coordination.endCollision();
                    }
                    
                    continue;
                }
                if (this.currentIntention.isStopped()) {
                    console.log(` Agent - ${this.currentIntention.goal} stopped`);
                    this.currentIntention = null;
                    continue;
                }

                if (!executed) {
                    console.log("Agent - Reason:", this.currentIntention.plan.lastFailureReason, "Fails:", this.currentIntention.plan.failedAttempts);

                    if (this.currentIntention && this.currentIntention.plan && this.currentIntention.plan.shouldAbort()) {
                        console.log(` Agent - ${this.currentIntention.goal} discarded (too many failures)`);
                        this.currentIntention.stop();
                        this.currentIntention = null;
                    }
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                    continue;
                }

                const act = executed;
                const type = act.action;

                if (type === "up" || type === "down" || type === "left" || type === "right") {
                    console.log(`Action: ${type}`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);

                    const after_x = Math.floor(this.beliefs.x);
                    const after_y = Math.floor(this.beliefs.y);

                    const ok = !(after_x === before_x && after_y === before_y);
                    console.log(ok ? ` Moved successfully` : ` Position NOT updated!`);
                    
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

                    const ok = (afterCarried > beforeCarried) || (!beforeHasParcel && afterHasParcel);
                    console.log(ok ? ` Pickup OK` : ` Pickup FAILED`);
                }
                else if (type === "putdown") {
                    console.log(`Action: putdown`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);

                    const afterHasParcel = this.beliefs.hasParcel();
                    const afterCarried = this.beliefs.parcels.filter(p => p.carriedBy === this.beliefs.id).length;

                    const ok = (afterCarried < beforeCarried) || (beforeHasParcel && !afterHasParcel);
                    console.log(ok ? ` Putdown OK` : ` Putdown FAILED`);
                }
                else {
                    console.log(`Action: ${type}`);
                    await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
                }

                if (this.currentIntention && this.currentIntention.plan && this.currentIntention.plan.shouldAbort()) {
                    console.log(` ${this.currentIntention.goal} discarded (too many failures)`);
                    this.currentIntention.stop();
                    this.currentIntention = null;
                    continue;
                }

                this.currentIntention.refreshCompletion();
                if (this.currentIntention.isCompleted()) {
                    console.log(` ${this.currentIntention.goal} completed`);
                    this.currentIntention = null;
                }
            } 
            catch (e) {
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