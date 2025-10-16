import { DeliverooApi } from '@unitn-asa/deliveroo-js-client';
import { Belief } from './beliefs/beliefs.js';
import { Pathfinding } from './utils/pathfinding.js';
import { Intention } from './intentions/intention.js';
import { PickUpPlan, DeliverPlan, RandomPlan, ExplorePlan } from './intentions/plans.js';
import { config } from './config.js';

export class DeliverooAgent {
    constructor(host, token) {
        this.client = new DeliverooApi(host, token);
        this.belief = new Belief();
        this.pathfinding = null;
        this.currentIntention = null;
        this.intentionQueue = [];

        this.ready = false;
        this.running = false;
        
        // Track last reset time for failed attempts
        this.lastFailedAttemptsReset = Date.now();
    }

    async start() {
        console.log('Starting Deliveroo Agent...');

        this.setupListeners();

        this.running = true;
        this.loop();
    }

    setupListeners() {
        // Map configuration
        this.client.onMap((width, height, tiles) => {
            console.log(`Received map: ${width}x${height}`);
            this.belief.initMap(width, height, tiles);
            this.pathfinding = new Pathfinding(this.belief.environment);

            if(!this.ready) this.setReady();
        });

        // Configuration updates
        this.client.onConfig((gameConfig) => {
            console.log('\n=== Game Configuration Received ===');
            
            // Update belief system with raw config
            this.belief.updateConfig(gameConfig);
            
            console.log('Configuration applied:');
            console.log(`  Movement Duration: ${gameConfig.MOVEMENT_DURATION}ms`);
            console.log(`  Parcel Observation Distance: ${gameConfig.PARCELS_OBSERVATION_DISTANCE}`);
            console.log(`  Decay Interval: ${gameConfig.PARCEL_DECADING_INTERVAL}`);
            console.log(`  Loss per Movement: ${this.belief.config.LOSS_PER_MOVEMENT?.toFixed(4) || 'N/A'}`);
            console.log('===================================\n');

            if(!this.ready) this.setReady();
        });

        // Agent updates
        this.client.onYou((data) => {
            this.belief.updateMe(data);
        });

        // Parcels sensing
        this.client.onParcelsSensing((parcels) => {
            this.belief.updateParcels(parcels);
        });

        // Agents sensing
        this.client.onAgentsSensing((agents) => {
            this.belief.updateAgents(agents);
        });
    }

    setReady() {
        if (this.belief.environment.ready && this.pathfinding) {
            this.ready = true;
            console.log('✓ Agent is ready to operate!\n');
        }
    }

    stop() {
        this.running = false;
    }

    async sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async loop() {
        while (this.running) {
            await new Promise(res => setTimeout(res, 100));

            if (!this.ready) {
                continue;
            }

            const me = this.belief.me;

            if (!me.id) {
                continue;
            }

            // Periodically reset failed attempts (every 30 seconds)
            const now = Date.now();
            if (now - this.lastFailedAttemptsReset > 30000) {
                console.log('Resetting failed parcel attempts...');
                this.belief.resetFailedAttempts();
                this.lastFailedAttemptsReset = now;
            }

            await this.deliberate();
        }
    }

    async deliberate() {
        // Check if current intention is still valid
        if (this.currentIntention) {
            if (this.currentIntention.isCompleted() || this.currentIntention.isStopped()) {
                console.log(`Intention '${this.currentIntention.goal}' completed\n`);
                this.currentIntention = null;
            }
            else {
                // Still executing current intention
                return;
            }
        }

        // Generate new intention based on beliefs
        const newIntention = this.generateIntention();

        if (newIntention) {
            console.log(`\n→ New intention: ${newIntention.goal.toUpperCase()}`);
            this.logAgentState();
            
            this.currentIntention = newIntention;
            await this.achieveIntention(newIntention);

            this.currentIntention = null;
        }
        else {
            // No intention generated - should not happen, but handle gracefully
            console.log('⚠ No intention generated, waiting...');
            await this.sleep(1000);
        }
    }

    // inside DeliverooAgentCoop
    generateIntention() {
    // 0) If we’re part of an already-booked handoff, honor it
        const pending = Team.getHandoffForAgent(this.belief.me.id);
        if (pending) {
            const it = new Intention(this.client, `handoff#${pending.parcelId}`);
            it.plan = new HandoffPlan(this.client, this.belief, this.pathfinding, pending);
            return it;
        }

        // 1) deliver if needed
        if (this.belief.shouldDeliver && this.belief.shouldDeliver()) {
            const it = new Intention(this.client, 'deliver');
            it.plan = new DeliverPlan(this.client, this.belief, this.pathfinding);
            return it;
        }

        // 2) if carrying but someone else is much closer to delivery, book a handoff
        if (this.belief.me.carriedParcels?.length) {
            const h = Team.recommendHandoff(this.belief);
            if (h) {
            Team.bookHandoff(h);
            const it = new Intention(this.client, `handoff#${h.parcelId}`);
            it.plan = new HandoffPlan(this.client, this.belief, this.pathfinding, h);
            return it;
            }
        }

        // 3) assigned parcel (prevents duplicate pursuit)
        const parcel = Team.assignBestParcel(this.belief.me.id, this.belief, this.pathfinding);
        if (parcel) {
            const it = new Intention(this.client, `pickup#${parcel.id}`);
            it.plan = new PickUpPlan(this.client, this.belief, this.pathfinding, parcel);
            return it;
        }

        // 4) patrol own region / fallback explore
        const region = Team.getRegionFor(this.belief.me.id);
        if (region) {
            const it = new Intention(this.client, 'explore-region');
            it.plan = new ExploreCoopPlan(this.client, this.belief, this.pathfinding, region);
            return it;
        }

        const it = new Intention(this.client, 'random');
        it.plan = new RandomPlan(this.client, this.belief, this.pathfinding);
        return it;
    }

    async achieveIntention(intention) {
        try {
            await intention.achieve();
        } 
        catch (error) {
            console.error('Error executing intention:', error);
            intention.stop();
        }
    }

    logAgentState() {
        const me = this.belief.me;
        const pos = `(${Math.round(me.x)}, ${Math.round(me.y)})`;
        const carrying = me.carriedParcels.length;
        const visible = this.belief.getAvailableParcels().length;
        
        console.log(`  Position: ${pos} | Carrying: ${carrying} | Visible parcels: ${visible} | Score: ${me.score}`);
    }
}