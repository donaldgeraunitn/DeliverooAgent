export class Plan {
    constructor(client, belief, pathfinding) {
        this.client = client;
        this.belief = belief;
        this.pathfinding = pathfinding;
        this.stopped = false;
        this.actions = [];
        this.consecutiveFailures = 0;
        this.maxConsecutiveFailures = 5;
    }

    async execute() {
        throw new Error('Execute method must be implemented by subclass');
    }

    stop() {
        this.stopped = true;
    }

    isStopped() {
        return this.stopped;
    }

    async executeAction(action) {
        try {
            // emitMove returns Promise<{x, y} | false>
            const result = await this.client.emitMove(action);
            
            if (result === false) {
                console.warn(`Movement ${action} failed (blocked or invalid)`);
                this.consecutiveFailures++;
                
                if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
                    console.error('Too many consecutive movement failures, stopping plan');
                    this.stop();
                }
                
                return false;
            }
            
            // Update belief with new position
            if (result && result.x !== undefined && result.y !== undefined) {
                this.belief.me.x = result.x;
                this.belief.me.y = result.y;
                // NEW: record visit for coverage-driven exploration
                this.belief.noteVisit(result.x, result.y);
                this.consecutiveFailures = 0; // Reset on success
            }
            
            return true;
        } 
        catch (error) {
            console.error('Error executing action:', error);
            this.consecutiveFailures++;
            
            if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
                this.stop();
            }
            
            return false;
        }
    }

    // Helper: Execute action sequence
    async executeActions(actions) {
        for (const action of actions) {
            if (this.stopped) break;
            const success = await this.executeAction(action);
            if (!success) break;
        }
    }

    async moveTo(targetX, targetY) {
        const maxAttempts = 50;
        let attempts = 0;

        while (!this.stopped && attempts < maxAttempts) {
            attempts++;

            // NEW: allow subclasses (Explore/Random) to yield for pickup/delivery
            if (this.shouldPreempt && this.shouldPreempt()) {
                console.log('Preempting current plan (higher-priority task available).');
                this.stop();            // signal the agent loop to re-deliberate
                return false;
            }

            const currentX = Math.round(this.belief.me.x);
            const currentY = Math.round(this.belief.me.y);

            if (currentX === targetX && currentY === targetY) {
                console.log(`✓ Reached target (${targetX}, ${targetY})`);
                return true;
            }

            const path = this.pathfinding.findPath(currentX, currentY, targetX, targetY);
            if (!path || path.length === 0) {
                console.log(`✗ No path found from (${currentX}, ${currentY}) to (${targetX}, ${targetY})`);
                return false;
            }

            const actions = this.pathfinding.pathToActions(path, currentX, currentY);
            if (actions.length === 0) {
                console.log('✓ Already at target');
                return true;
            }

            const nextAction = actions[0];
            const success = await this.executeAction(nextAction);
            if (!success) {
                console.log(`✗ Failed to execute ${nextAction}, cannot reach target`);
                return false;
            }

            await new Promise(r => setTimeout(r, 50));
        }

        if (attempts >= maxAttempts) {
            console.error(`✗ Max attempts (${maxAttempts}) reached trying to reach (${targetX}, ${targetY})`);
            return false;
        }

        return false;
    }

    // By default, plans are not preemptible.
    // Explore/Random will override this to yield when parcels/delivery are available.
    shouldPreempt() { 
        return false; 
    }

}
