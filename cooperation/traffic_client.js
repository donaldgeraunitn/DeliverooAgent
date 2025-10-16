// traffic_client.js
import { Team } from './team.js';

const DIR = {
  up:    { dx: 0, dy: -1 },
  down:  { dx: 0, dy:  1 },
  left:  { dx: -1, dy: 0 },
  right: { dx:  1, dy: 0 },
};

export class TrafficAwareClient {
  /**
   * @param {DeliverooApi} rawClient
   * @param {Belief} belief
   * @param {() => any} envProvider
   */
  constructor(rawClient, belief, envProvider) {
    this._c = rawClient;
    this._belief = belief;
    this._envProvider = envProvider;

    // Proxy server event hooks transparently
    ['onMap','onConfig','onYou','onParcelsSensing','onAgentsSensing'].forEach(ev => {
      this[ev] = (...args) => this._c[ev](...args);
    });
  }

  _targetFor(action, x, y) {
    const d = DIR[action];
    if (!d) return { x, y };
    return { x: Math.round(x + d.dx), y: Math.round(y + d.dy) };
  }

  /**
   * Reserve the move (anti-collision) before sending it to the server.
   */
  async emitMove(action) {
    const me = this._belief.me || { x: 0, y: 0, id: undefined };
    const from = { x: Math.round(me.x), y: Math.round(me.y) };
    const to   = this._targetFor(action, from.x, from.y);

    // no-op
    if (to.x === from.x && to.y === from.y) return { x: from.x, y: from.y };

    // update team position + reserve
    if (me.id != null) {
      Team.updateAgentPos(me.id, from.x, from.y);
      await Team.reserveMove(me.id, from, to);
    }

    // perform move
    const res = await this._c.emitMove(action);

    // update final pos in team
    if (res && res.x !== undefined && res.y !== undefined && me.id != null) {
      Team.updateAgentPos(me.id, Math.round(res.x), Math.round(res.y));
      return { x: Math.round(res.x), y: Math.round(res.y) };
    }
    return res;
  }

  async emitPickup(...args)  { return this._c.emitPickup(...args); }
  async emitPutdown(...args) { return this._c.emitPutdown(...args); }
}
