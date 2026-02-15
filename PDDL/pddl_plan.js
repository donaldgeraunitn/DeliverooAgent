import { PddlProblem, onlineSolver } from "@unitn-asa/pddl-client";
import { Plan } from "../BDI - plans/plan.js";
import { manhattanDistance } from "../Util/utils.js";
import { readFileSync } from "fs";

// ─── helpers ────────────────────────────────────────────────────────────────

function tileName(x, y) { return `t${x}_${y}`; }

function parseTileName(name) {
    // ✅ FIX: Handle both lowercase 't0_4' and uppercase 'T0_4'
    const parts = name.replace(/^t/i, "").split("_");
    return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) };
}

// ─── PDDLPlan ───────────────────────────────────────────────────────────────

export class PDDLPlan extends Plan {
    constructor(beliefs, pathfinding, coordination = null, domainPath = "./PDDL/domain.pddl") {
        super(beliefs, pathfinding, coordination);

        this.domainString = null;
        this.domainPath   = domainPath;

        // ── State fields (see state machine in header) ──────────────────
        this.started      = false;  // true once getAction() initiates planning
        this.planning     = false;  // true while waiting for async solver
        this.actionQueue  = [];     // queued actions from solver
        this.targetParcel = null;   // the parcel this plan was built for
        this.startPos     = null;   // agent pos when plan was requested
        
        // ── PDDL Solver Timeout (configurable) ──────────────────────────
        this.solverTimeout = beliefs.config.PDDL_SOLVER_TIMEOUT || 30000; // 30 seconds default
    }

    // ── Lazy-load the domain file ───────────────────────────────────────────

    loadDomain() {
        if (this.domainString) return true;
        try {
            this.domainString = readFileSync(this.domainPath, "utf-8");
            console.log("[PDDLPlan] Domain loaded from", this.domainPath);
            return true;
        } catch (err) {
            console.error("[PDDLPlan] Could not read domain file:", err.message);
            return false;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  STATE QUERIES — used by agent.js and intention.js
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * True when the plan is actively working: solver running or actions queued.
     * The agent must NOT interrupt this with Pickup/Deliver.
     */
    isExecuting() {
        return this.actionQueue.length > 0 || this.planning;
    }

    /**
     * True when the plan ran and finished (successfully or not).
     * FALSE for a plan that was never started — this is the key distinction
     * that prevents the "completed before started" bug.
     *
     * State breakdown:
     *   IDLE      (started=false)                        → false
     *   PLANNING  (started=true, planning=true)          → false
     *   EXECUTING (started=true, queue.length > 0)       → false
     *   DONE      (started=true, !planning, queue=[], target=null) → true
     */
    isCompleted() {
        return this.started
            && this.actionQueue.length === 0
            && !this.planning
            && this.targetParcel === null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  MAIN ENTRY POINT — called every tick by Intention.step()
    // ═════════════════════════════════════════════════════════════════════════

    getAction() {
        const pos = {
            x: Math.floor(this.beliefs.x),
            y: Math.floor(this.beliefs.y),
        };
        if (pos.x === -1 || pos.y === -1) return null;

        // ── Phase 1: executing queued actions ───────────────────────────
        if (this.actionQueue.length > 0) {
            return this.consumeNext(pos);
        }

        // ── Phase 2: waiting for solver ─────────────────────────────────
        if (this.planning) {
            return null;   // wait for async solver to fill the queue
        }

        // ── Phase 3: start a new plan ───────────────────────────────────
        //
        //  ALL synchronous work happens HERE, before setting planning=true.
        //  This prevents the bug where a synchronous throw inside the async
        //  callSolver() would clear planning=true on the same tick.
        //

        // 3a. Find best parcel
        const parcel = this.selectBestParcel(pos);
        if (!parcel) {
            this.fail("No suitable parcel for PDDL plan");
            return null;
        }

        // 3b. Load domain (sync, cached after first load)
        if (!this.loadDomain()) {
            this.fail("Domain not loaded");
            return null;
        }

        // 3c. Find delivery tile (sync)
        const delivery = this.beliefs.environment.getClosestDeliveryTile(parcel.x, parcel.y);
        if (!delivery) {
            this.fail("No delivery tile");
            return null;
        }

        // 3d. Build the PDDL problem string (sync)
        let problemString;
        try {
            const problem = this.buildProblem(pos, parcel, delivery);
            problemString = problem.toPddlString();
        } catch (err) {
            console.error("[PDDLPlan] Failed to build problem:", err.message || err);
            this.fail("Problem build failed");
            return null;
        }

        // 3e. All sync work succeeded → commit to planning state.
        //     From this point: isExecuting()=true, isCompleted()=false.
        this.started      = true;    // marks the plan as "has been initiated"
        this.planning     = true;
        this.targetParcel = parcel;
        this.startPos     = { ...pos };

        console.log(`[PDDLPlan] Calling online solver for parcel ${parcel.id} …`);

        // 3f. Fire the ONLY async part: the solver HTTP call.
        this.callSolver(problemString);

        return null;   // wait for solver on next tick(s)
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ASYNC SOLVER CALL
    // ═════════════════════════════════════════════════════════════════════════

    async callSolver(problemString) {
        // Force async boundary: guarantees the catch block NEVER runs
        // synchronously on the same tick as getAction().
        await Promise.resolve();

        try {
            // ═══════════════════════════════════════════════════════════════
            // TIMEOUT PROTECTION: Wrap solver in Promise.race
            // ═══════════════════════════════════════════════════════════════
            
            const solverPromise = onlineSolver(this.domainString, problemString);
            
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`PDDL solver timeout after ${this.solverTimeout}ms`));
                }, this.solverTimeout);
            });
            
            const solverResult = await Promise.race([solverPromise, timeoutPromise]);

            if (!solverResult || !Array.isArray(solverResult) || solverResult.length === 0) {
                console.warn("[PDDLPlan] Solver returned no plan");
                this.fail("Solver returned empty plan");
                this.planning     = false;
                this.targetParcel = null;
                return;
            }

            this.actionQueue = this.translatePlan(solverResult, this.startPos);
            this.planning = false;   // PLANNING → EXECUTING
            console.log(`[PDDLPlan] Plan ready: ${this.actionQueue.length} actions`);

        } catch (err) {
            console.error("[PDDLPlan] Solver error:", err.message || err);
            this.fail("Solver error");
            this.planning     = false;
            this.targetParcel = null;
            // State is now DONE (started=true, planning=false, queue=[], target=null)
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  PARCEL SELECTION — mirrors Pickup logic, uses A* for utility
    // ═════════════════════════════════════════════════════════════════════════

    selectBestParcel(pos) {
        const candidates = this.beliefs.getAvailableParcels().filter(p => {
            if (p.carriedBy) return false;

            const myDist = manhattanDistance(pos.x, pos.y, p.x, p.y);
            for (const agent of this.beliefs.agents) {
                if (agent.id === this.beliefs.id) continue;
                if (this.coordination && agent.id === this.beliefs.partnerId) continue;
                const ad = manhattanDistance(Math.floor(agent.x), Math.floor(agent.y), p.x, p.y);
                if (ad + 1 < myDist) return false;
            }
            return true;
        });

        // Zone filter (normal multi-agent mode)
        let filtered = candidates;
        if (this.beliefs.myArea && this.beliefs.myArea.length > 0) {
            const zoned = candidates.filter(p =>
                this.beliefs.myArea.some(t => t.x === Math.floor(p.x) && t.y === Math.floor(p.y))
            );
            if (zoned.length > 0) filtered = zoned;
        }

        let best = null;
        let bestUtil = 0;
        for (const p of filtered) {
            const u = this.calculateUtility(pos.x, pos.y, p);
            if (u > bestUtil) { bestUtil = u; best = p; }
        }
        return best;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  PDDL PROBLEM GENERATION (synchronous)
    // ═════════════════════════════════════════════════════════════════════════

    buildProblem(pos, parcel, delivery) {
        const env = this.beliefs.environment;

        const padding = 20;
        const xs = [pos.x, parcel.x, delivery.x];
        const ys = [pos.y, parcel.y, delivery.y];
        const minX = Math.max(0, Math.min(...xs) - padding);
        const maxX = Math.min(env.width - 1, Math.max(...xs) + padding);
        const minY = Math.max(0, Math.min(...ys) - padding);
        const maxY = Math.min(env.height - 1, Math.max(...ys) + padding);

        const objects = [];
        const inits   = [];

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                if (!env.isReachable(x, y)) continue;

                const name = tileName(x, y);
                objects.push(name);

                // ✅ FIX: Only add neighbor predicates if neighbor is ALSO in bounded area
                if (x + 1 >= minX && x + 1 <= maxX && env.isReachable(x + 1, y)) {
                    inits.push(`(right ${tileName(x + 1, y)} ${name})`);
                }
                if (x - 1 >= minX && x - 1 <= maxX && env.isReachable(x - 1, y)) {
                    inits.push(`(left  ${tileName(x - 1, y)} ${name})`);
                }
                if (y + 1 >= minY && y + 1 <= maxY && env.isReachable(x, y + 1)) {
                    inits.push(`(up    ${tileName(x, y + 1)} ${name})`);
                }
                if (y - 1 >= minY && y - 1 <= maxY && env.isReachable(x, y - 1)) {
                    inits.push(`(down  ${tileName(x, y - 1)} ${name})`);
                }
            }
        }

        const parcelName = `p_${parcel.id}`;
        objects.push(parcelName);

        inits.push(`(at ${tileName(pos.x, pos.y)})`);
        inits.push(`(parcel_at ${parcelName} ${tileName(Math.floor(parcel.x), Math.floor(parcel.y))})`);

        // ✅ FIX: No outer parentheses on goal - PddlProblem adds them
        const goal = `parcel_at ${parcelName} ${tileName(delivery.x, delivery.y)}`;

        return new PddlProblem(
            "deliveroo",
            objects.join(" "),
            inits.join(" "),
            goal
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  TRANSLATE SOLVER OUTPUT → AGENT ACTIONS
    // ═════════════════════════════════════════════════════════════════════════

    translatePlan(solverActions, startPos) {
        const actions = [];
        let currentPos = { ...startPos };

        for (const step of solverActions) {
            const name = (step.action || step.name || "").toLowerCase();

            if (name.startsWith("move-")) {
                const dest = parseTileName(step.args[1]);
                const dir  = this.directionBetween(currentPos, dest);
                if (dir) {
                    actions.push({ action: dir });
                    currentPos = dest;
                } else {
                    console.warn(`[PDDLPlan] Bad direction: (${currentPos.x},${currentPos.y}) → (${dest.x},${dest.y})`);
                }
            }
            else if (name === "pick-up") {
                actions.push({ action: "pickup" });
            }
            else if (name === "put-down") {
                actions.push({ action: "putdown" });
            }
            else {
                console.warn("[PDDLPlan] Unknown solver action:", name);
            }
        }

        return actions;
    }

    directionBetween(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (dx ===  1 && dy ===  0) return "right";
        if (dx === -1 && dy ===  0) return "left";
        if (dx ===  0 && dy ===  1) return "up";
        if (dx ===  0 && dy === -1) return "down";
        return null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  EXECUTE ONE ACTION FROM QUEUE
    // ═════════════════════════════════════════════════════════════════════════

    consumeNext(pos) {
        // Before pickup phase: check the target parcel still exists
        if (this.targetParcel && !this.beliefs.hasParcel()) {
            const still = this.beliefs.parcels.find(
                p => p.id === this.targetParcel.id && !p.carriedBy
            );
            if (!still) {
                console.log("[PDDLPlan] Target parcel gone, discarding plan");
                this.invalidate();
                return null;
            }
        }

        const next = this.actionQueue.shift();

        // After putdown: clear target → state becomes DONE next tick
        if (next.action === "putdown") {
            this.targetParcel = null;
        }

        return next;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═════════════════════════════════════════════════════════════════════════

    /** Discard the current plan (parcel stolen, path blocked, etc.) */
    invalidate() {
        this.actionQueue  = [];
        this.targetParcel = null;
        this.planning     = false;
        // NOTE: `started` is NOT reset here. After invalidation the plan
        // is in DONE state, so the intention will be marked completed and
        // the agent will select a new intention on the next tick.
    }

    /**
     * Reset state back to IDLE for a new attempt, WITHOUT clearing
     * the failure counter. This allows shouldAbort() to accumulate
     * failures across attempts.
     */
    prepareForNewPlan() {
        this.invalidate();
        this.started = false;   // back to IDLE
    }

    /** Full reset — clears failure counter AND state. */
    resetFailures() {
        super.resetFailures();
        this.invalidate();
        this.started = false;
    }
}