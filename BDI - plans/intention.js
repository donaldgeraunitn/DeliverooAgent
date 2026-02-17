export class Intention {
    constructor(client, beliefs, goal, plan, priority) {
        this.client = client;
        this.beliefs = beliefs;

        // High-level intention metadata (what we want + how we execute it)
        this.goal = goal;          // e.g., "pickup", "deliver", "pddl"
        this.plan = plan;          // Plan instance that decides next action
        this.priority = priority;  // Used by scheduler / preemption logic

        // Lifecycle flags managed by this wrapper
        this.completed = false;
        this.stopped = false;
    }

    canBePreemptedBy(other) {
        // Higher-priority intentions can interrupt lower-priority ones
        return other && other.priority > this.priority;
    }

    stop() {
        // Mark as stopped and reset any navigation state inside the plan
        this.stopped = true;
        if (this.plan) this.plan.clearPath();
    }

    refreshCompletion() {
        // Completion rules depend on the type of goal:
        // - pickup completes once we are carrying at least one parcel
        // - deliver completes once we are carrying none
        if (this.goal === "pickup" && this.beliefs.hasParcel()) this.completed = true;
        if (this.goal === "deliver" && !this.beliefs.hasParcel()) this.completed = true;

        // PDDL completion is delegated to the plan's internal state machine/queue
        if (this.goal === "pddl" && this.plan.isCompleted()) this.completed = true;
    }

    isCompleted() { 
        return this.completed; 
    }

    isStopped() { 
        return this.stopped; 
    }

    async step() {
        // One execution tick: query plan for next action and dispatch it to the client
        if (this.stopped) return null;

        // If intention is already complete, do nothing
        this.refreshCompletion();
        if (this.completed) return null;

        if (!this.plan) throw new Error("Intention - No plan to execute");

        // Allow the plan to abort itself (e.g., impossible target / inconsistent state)
        if (this.plan.shouldAbort()) {
            this.stop();
            return null;
        }

        // Ask the plan what to do next (move/pickup/putdown/...)
        const act = this.plan.getAction();

        // No action means plan is waiting / cannot progress right now
        if (!act) {
            if (this.plan.shouldAbort()) this.stop();
            this.refreshCompletion();
            return null;
        }

        const type = act.action;
        console.log(`[${this.goal}] Action: ${type}${act.id ? ` (parcel ${act.id})` : ''}`);

        try {
            if (type === "pickup") {
                await this.client.emitPickup(act.id);
            }
            else if (type === "putdown") {
                await this.client.emitPutdown();
            }
            else {
                await this.client.emitMove(type);
            }
        }
        catch (e) {
            if (this.plan) this.plan.onActionResult(act, false, { reason: "Intention Error - ", error: e });

            // If failure makes the plan invalid, stop this intention
            if (this.plan && this.plan.shouldAbort()) this.stop();

            return null;
        }

        return act;
    }
}
