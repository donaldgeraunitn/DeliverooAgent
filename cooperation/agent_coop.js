// agent_coop.js
import { DeliverooAgent } from '../agent.js';
import { TrafficAwareClient } from './traffic_client.js';
import { Team } from './team.js';
import { Intention } from '../intentions/intention.js';
import { Pathfinding } from '../utils/pathfinding.js';
import { PickUpPlan, DeliverPlan, RandomPlan, ExplorePlan } from '../intentions/plans.js';
import { ExploreCoopPlan, HandoffPlan } from './plans_coop.js';

export class DeliverooAgentCoop extends DeliverooAgent {
  constructor(host, token) { super(host, token); }

  async start() {
    this.client = new TrafficAwareClient(this.client, this.belief, () => this.belief.environment);
    this.setupListeners();

    // Register for team coordination when 'you' arrives
    this.client.onYou((data) => {
      this.belief.updateMe(data);
      if (this.belief.me?.id != null) {
        Team.registerAgent(this.belief.me.id, this.belief.me.name || 'agent');
        Team.updateAgentPos(this.belief.me.id, this.belief.me.x, this.belief.me.y);
        Team.setEnv(this.belief.environment);
      }
    });

    this.client.onParcelsSensing((parcels) => this.belief.updateParcels(parcels));
    this.client.onAgentsSensing((agents)   => this.belief.updateAgents(agents));

    // Keep a pathfinder handy
    if (!this.pathfinding) this.pathfinding = new Pathfinding(this.belief.environment);

    this.running = true;
    this.loop();
  }

  // Cooperative intention generator (handoff check BEFORE deliver)
  generateIntention() {
    // 0) honor a booked handoff
    const pending = Team.getHandoffForAgent(this.belief.me.id);
    if (pending) {
      const it = new Intention(this.client, `handoff#${pending.parcelId}`);
      it.plan = new HandoffPlan(this.client, this.belief, this.pathfinding, pending);
      return it;
    }

    // 1) carrying? evaluate handoff with reachability-aware rules
    if ((this.belief.me?.carriedParcels?.length || 0) > 0) {
      const h = Team.recommendHandoff(this.belief, this.pathfinding);
      if (h) {
        Team.bookHandoff(h);
        const it = new Intention(this.client, `handoff#${h.parcelId}`);
        it.plan = new HandoffPlan(this.client, this.belief, this.pathfinding, h);
        return it;
      }
    }

    // 2) deliver if carrying and heuristic says so
    if (this.belief.shouldDeliver?.() === true) {
      const it = new Intention(this.client, 'deliver');
      it.plan = new DeliverPlan(this.client, this.belief, this.pathfinding);
      return it;
    }

    // 3) cooperative parcel assignment
    const parcel = Team.assignBestParcel(this.belief.me.id, this.belief);
    if (parcel) {
      const it = new Intention(this.client, `pickup#${parcel.id}`);
      it.plan = new PickUpPlan(this.client, this.belief, this.pathfinding, parcel);
      return it;
    }

    // 4) explore region / fallback
    const region = Team.getRegionFor(this.belief.me.id);
    if (region) {
      const it = new Intention(this.client, 'explore-region');
      it.plan = new ExploreCoopPlan(this.client, this.belief, this.pathfinding, region);
      return it;
    }

    if ((this.belief.environment?.spawnerTiles?.length || 0) > 0) {
      const it = new Intention(this.client, 'explore');
      it.plan = new ExplorePlan(this.client, this.belief, this.pathfinding);
      return it;
    }

    const it = new Intention(this.client, 'random');
    it.plan = new RandomPlan(this.client, this.belief, this.pathfinding);
    return it;
  }
}
