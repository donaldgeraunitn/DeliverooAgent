export class Intention {
    constructor(agent, goal) {
        this.agent = agent;
        this.goal = goal;
        this.plan = null;
        this.completed = false;
        this.stopped = false;
    }

    async achieve() {
        if (!this.plan) {
            throw new Error('No plan assigned to intention');
        }

        try {
            await this.plan.execute();
            this.completed = true;
            return true;
        } 
        catch (error) {
            console.error('Intention execution failed:', error);
            this.stopped = true;
            return false;
        }
    }

    stop() {
        this.stopped = true;
        if (this.plan) this.plan.stop();
    }

    isCompleted() {
        return this.completed;
    }

    isStopped() {
        return this.stopped;
    }
}