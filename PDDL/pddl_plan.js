import { PddlProblem, onlineSolver } from "@unitn-asa/pddl-client";
import { Plan } from "../BDI - plans/plan.js";
import { manhattanDistance } from "../Utils/utils.js";
import { readFileSync } from "fs";

function tileName(x, y) { return `t${x}_${y}`; }

function parseTileName(name) {
    const parts = name.replace(/^t/i, "").split("_");
    return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) };
}

export class PDDLPlan extends Plan {
    constructor(beliefs, pathfinding, coordination = null, domainPath = "./PDDL/domain.pddl") {
        super(beliefs, pathfinding, coordination);

        // Cached domain content (loaded once on demand)
        this.domainString = null;
        this.domainPath   = domainPath;

        // Internal state (plan lifecycle)
        this.started      = false;  // becomes true the first time we commit to a planning attempt
        this.planning     = false;  // true while the async solver request is pending
        this.actionQueue  = [];     // translated actions to execute (move/pickup/putdown)
        this.targetParcel = null;   // parcel used to build the current plan (for validation)
        this.startPos     = null;   // agent position when the plan was requested (used for translation)

        this.solverTimeout = beliefs.config.PDDL_SOLVER_TIMEOUT;
    }

    // Loads the PDDL domain file once and caches it
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

    isExecuting() {
        return this.actionQueue.length > 0 || this.planning;
    }

    // True only after a planning attempt has started AND everything has fully finished/cleared
    isCompleted() {
        return this.started && this.actionQueue.length === 0 && !this.planning && this.targetParcel === null;
    }

    getAction() {
        const pos = {
            x: Math.floor(this.beliefs.x),
            y: Math.floor(this.beliefs.y),
        };
        if (pos.x === -1 || pos.y === -1) return null;

        // If we already have solver actions, execute them one-by-one
        if (this.actionQueue.length > 0) {
            return this.consumeNext(pos);
        }

        // If solver is running, do nothing this tick
        if (this.planning) {
            return null;
        }

        // Start a new planning attempt: all synchronous checks happen before setting planning=true

        // Pick the best parcel candidate (utility-based + steal-avoidance + zone-filter)
        const parcel = this.selectBestParcel(pos);
        if (!parcel) {
            this.fail("No suitable parcel for PDDL plan");
            return null;
        }

        // Ensure domain is available (cached after first successful load)
        if (!this.loadDomain()) {
            this.fail("Domain not loaded");
            return null;
        }

        // Choose a delivery target (closest delivery tile to parcel position)
        const delivery = this.beliefs.environment.getClosestDeliveryTile(parcel.x, parcel.y);
        if (!delivery) {
            this.fail("No delivery tile");
            return null;
        }

        // Build the concrete PDDL problem for this (pos, parcel, delivery) triplet
        let problemString;
        try {
            const problem = this.buildProblem(pos, parcel, delivery);
            problemString = problem.toPddlString();
        } 
        catch (err) {
            console.error("[PDDLPlan] Failed to build problem:", err.message || err);
            this.fail("Problem build failed");
            return null;
        }

        // Commit to planning state only after all sync work succeeded
        this.started = true;
        this.planning = true;
        this.targetParcel = parcel;
        this.startPos = { ...pos };

        console.log(`[PDDLPlan] Calling online solver for parcel ${parcel.id} …`);
        this.callSolver(problemString);

        return null;
    }

    async callSolver(problemString) {
        await Promise.resolve();
        try {
            // Start solver and race it against a timeout
            const solverPromise = onlineSolver(this.domainString, problemString);

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`PDDL solver timeout after ${this.solverTimeout}ms`));
                }, this.solverTimeout);
            });

            const solverResult = await Promise.race([solverPromise, timeoutPromise]);

            // A missing/empty plan means the solver could not find a solution
            if (!solverResult || !Array.isArray(solverResult) || solverResult.length === 0) {
                console.warn("[PDDLPlan] Solver returned no plan");
                this.fail("Solver returned empty plan");
                this.planning     = false;
                this.targetParcel = null;
                return;
            }

            // Translate solver actions (tile-names) into Deliveroo actions (move dir / pickup / putdown)
            this.actionQueue = this.translatePlan(solverResult, this.startPos);

            this.planning = false;
            console.log(`[PDDLPlan] Plan ready: ${this.actionQueue.length} actions`);

        } 
        catch (err) {
            console.error("[PDDLPlan] Solver error:", err.message || err);
            this.fail("Solver error");
            this.planning     = false;
            this.targetParcel = null;
        }
    }

    selectBestParcel(pos) {
        // Candidate parcels:
        // - not carried
        // - not “stolen” (skip parcels where another agent is significantly closer)
        const candidates = this.beliefs.getAvailableParcels().filter(p => {
            if (p.carriedBy) return false;

            const myDistance = manhattanDistance(pos.x, pos.y, p.x, p.y);
            for (const agent of this.beliefs.agents) {
                if (agent.id === this.beliefs.id) continue;
                if (this.coordination && agent.id === this.beliefs.partnerId) continue;

                const agentDistance = manhattanDistance(Math.floor(agent.x), Math.floor(agent.y), p.x, p.y);
                if (agentDistance + this.beliefs.config.AGENTS_OBSERVATION_DISTANCE * 0.2 < myDistance) return false;
            }
            return true;
        });

        // Optional zone restriction: prefer parcels inside assigned area when available
        let filtered = candidates;
        if (this.beliefs.myArea && this.beliefs.myArea.length > 0) {
            const zoned = candidates.filter(p =>
                this.beliefs.myArea.some(t => t.x === Math.floor(p.x) && t.y === Math.floor(p.y))
            );
            if (zoned.length > 0) filtered = zoned;
        }

        // Choose parcel with best utility (must beat baseline “deliver” utility inside calculateUtility)
        let best = null;
        let bestUtil = 0;
        for (const p of filtered) {
            const u = this.calculateUtility(pos.x, pos.y, p);
            if (u > bestUtil) { bestUtil = u; best = p; }
        }
        return best;
    }

    buildProblem(pos, parcel, delivery) {
        const env = this.beliefs.environment;

        // Limit the PDDL problem to a bounding box around relevant points to keep problem small
        const padding = 20;
        const xs = [pos.x, parcel.x, delivery.x];
        const ys = [pos.y, parcel.y, delivery.y];
        const minX = Math.max(0, Math.min(...xs) - padding);
        const maxX = Math.min(env.width - 1, Math.max(...xs) + padding);
        const minY = Math.max(0, Math.min(...ys) - padding);
        const maxY = Math.min(env.height - 1, Math.max(...ys) + padding);

        const objects = []; // PDDL objects: tiles + one parcel object
        const inits   = []; // PDDL init predicates: adjacency, agent position, parcel position

        // Add tile objects and directional adjacency predicates within the bounded window
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                if (!env.isReachable(x, y)) continue;

                const name = tileName(x, y);
                objects.push(name);

                // Only create links to neighbors that are reachable AND inside the bounding box
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

        // Add parcel object
        const parcelName = `p_${parcel.id}`;
        objects.push(parcelName);

        // Initial state: agent position + parcel position
        inits.push(`(at ${tileName(pos.x, pos.y)})`);
        inits.push(`(parcel_at ${parcelName} ${tileName(Math.floor(parcel.x), Math.floor(parcel.y))})`);

        // Goal: parcel must end up at the selected delivery tile
        const goal = `parcel_at ${parcelName} ${tileName(delivery.x, delivery.y)}`;

        return new PddlProblem( "deliveroo", objects.join(" "),  inits.join(" "), goal );
    }

    translatePlan(solverActions, startPos) {
        // Convert solver plan steps into the agent's action format:
        // - move-* -> direction move
        // - pick-up -> pickup
        // - put-down -> putdown
        const actions = [];
        let currentPos = { ...startPos };

        for (const step of solverActions) {
            const name = (step.action || step.name || "").toLowerCase();

            if (name.startsWith("move-")) {
                // Solver args encode destination tile name
                const dest = parseTileName(step.args[1]);
                const dir  = this.getAction(currentPos, dest);

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

    getAction(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (dx ===  1 && dy ===  0) return "right";
        if (dx === -1 && dy ===  0) return "left";
        if (dx ===  0 && dy ===  1) return "up";
        if (dx ===  0 && dy === -1) return "down";
        return null;
    }

    consumeNext(pos) {
        if (this.targetParcel && !this.beliefs.hasParcel()) {
            const still = this.beliefs.parcels.find( p => p.id === this.targetParcel.id && !p.carriedBy );
            if (!still) {
                console.log("[PDDLPlan] Target parcel gone, discarding plan");
                this.invalidate();
                return null;
            }
        }

        const next = this.actionQueue.shift();
        if (next.action === "putdown") {
            this.targetParcel = null;
        }

        return next;
    }

    invalidate() {
        this.actionQueue  = [];
        this.targetParcel = null;
        this.planning     = false;
    }

    prepareForNewPlan() {
        // Reset to a “fresh” idle attempt without clearing failure counters
        this.invalidate();
        this.started = false;
    }

    resetFailures() {
        super.resetFailures();
        this.invalidate();
        this.started = false;
    }
}
