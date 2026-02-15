export class Intention {
    constructor(client, beliefs, goal, plan, priority) {
        this.client = client;
        this.beliefs = beliefs;

        this.goal = goal;
        this.plan = plan;
        this.priority = priority;

        this.completed = false;
        this.stopped = false;
    }

    canBePreemptedBy(other) {
        return other && other.priority > this.priority;
    }

    stop() {
        this.stopped = true;
        if (this.plan) this.plan.clearPath();
    }

    refreshCompletion() {
        if (this.goal === "pickup" && this.beliefs.hasParcel()) this.completed = true;
        if (this.goal === "deliver" && !this.beliefs.hasParcel()) this.completed = true;

        // PDDL plan completes when its action queue is fully drained AND putdown was executed.
        // Unlike pickup/deliver, we do NOT check hasParcel() here because the PDDL plan
        // spans both phases (pickup + delivery) — it manages its own completion via isCompleted().
        if (this.goal === "pddl" && this.plan.isCompleted()) this.completed = true;
    }

    isCompleted() { return this.completed; }

    isStopped() { return this.stopped; }

    async step() {
        if (this.stopped) return null;

        this.refreshCompletion();
        if (this.completed) return null;

        if (!this.plan) throw new Error("Intention - No plan to execute");

        if (this.plan.shouldAbort()) {
            this.stop();
            return null;
        }

        const act = this.plan.getAction();

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
            if (this.plan && this.plan.shouldAbort()) this.stop();
            return null;
        }

        return act;
    }
}