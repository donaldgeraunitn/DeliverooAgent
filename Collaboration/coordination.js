import { Message, MessageHeader } from './message.js';
import { HandoverDetector } from './handover_detector.js';
import { manhattanDistance } from '../Utils/utils.js';

// Coordination can run in plain “zone-based” mode or in “handover” mode (collector/courier split)
const COORDINATION_MODE = {
    NORMAL: 'NORMAL',
    HANDOVER: 'HANDOVER'
};

// Role assignment used only in HANDOVER mode
const HANDOVER_ROLE = {
    COLLECTOR: 'COLLECTOR',
    COURIER: 'COURIER',
    UNDECIDED: 'UNDECIDED'
};

export class Coordination {
    constructor(client, beliefs, pathfinding) {
        this.client = client;
        this.beliefs = beliefs;
        this.pathfinding = pathfinding;

        // Static analysis helper to decide whether to enable handover mode
        this.handoverDetector = new HandoverDetector(beliefs, pathfinding);

        // Current coordination mode + reason (if handover is enabled)
        this.mode = COORDINATION_MODE.NORMAL;
        this.handoverReason = null;

        // Small two-agent collision protocol state machine
        this.collisionState = {
            active: false,
            initiator: false,
            phase: null,
            waitingFor: null,
            context: null,
            startTime: 0
        };

        // Shared intention exchange (used for conflict detection / yielding)
        this.myIntention = null;
        this.partnerIntention = null;

        // Handover mode configuration
        this.handoverRole = HANDOVER_ROLE.UNDECIDED;
        this.partnerHandoverRole = null;
        this.spawnTile = null;
        this.deliveryTile = null;
        this.handoverTile = null;

        this.setupListener();
    }

    setupListener() {
        // Register message handler for coordination messages
        this.client.onMsg((id, name, msg, reply) => {
            if (id === this.beliefs.id) return;
            this.handleMessage(id, msg);
        });
    }

    handleMessage(senderId, msg) {
        // Dispatch by message header
        switch (msg.header) {
            case MessageHeader.HANDSHAKE:
                this.handleHandshake(senderId, msg);
                break;
            case MessageHeader.HANDSHAKE_ACK:
                this.handleHandshakeAck(senderId, msg);
                break;
            // case MessageHeader.PARCEL_INFO:
            //     this.handleParcelInfo(msg.content);
            //     break;
            case MessageHeader.AGENT_INFO:
                this.handleAgentInfo(msg.content);
                break;
            case MessageHeader.INTENTION:
                this.handleIntention(senderId, msg.content);
                break;
            case MessageHeader.COLLISION:
                this.handleCollision(senderId, msg.content);
                break;
            case MessageHeader.HANDOVER_ROLE:
                this.handleHandoverRole(senderId, msg.content);
                break;
        }
    }

    async startPartnerDiscovery() {
        // Keep broadcasting handshake until a partner is confirmed
        if (this.beliefs.hasPartner()) return;

        this.handshakeInterval = setInterval(async () => {
            if (this.beliefs.hasPartner()) {
                clearInterval(this.handshakeInterval);
                return;
            }
            await this.sendHandshake();
        }, this.beliefs.config.MOVEMENT_DURATION * 2);

        await this.sendHandshake();
    }

    async sendHandshake() {
        // Broadcast request to form a partnership (include current position)
        const msg = new Message(
            MessageHeader.HANDSHAKE,
            'request_partner',
            { id: this.beliefs.id, x: this.beliefs.x, y: this.beliefs.y }
        );
        await this.client.emitShout(msg);
    }

    async handleHandshake(id, message) {
        // First receiver of a handshake accepts if currently unpaired
        if (this.beliefs.hasPartner()) return;

        this.beliefs.setPartner({ id: message.sender.id, x: message.sender.x, y: message.sender.y });

        const ack = new Message(
            MessageHeader.HANDSHAKE_ACK,
            'partner_accepted',
            { id: this.beliefs.id, x: this.beliefs.x, y: this.beliefs.y }
        );
        await this.client.emitSay(ack, id);

        console.log(`[Coordination] Partnership established with ${id}`);

        if (this.handshakeInterval) {
            clearInterval(this.handshakeInterval);
        }
    }

    handleHandshakeAck(senderId, msg) {
        // If we don't have a partner yet, store sender as partner (and take sender position if present)
        if (!this.beliefs.partnerId) {
            const partnerInfo = {
                id: senderId,
                x: msg.sender ? msg.sender.x : -1,
                y: msg.sender ? msg.sender.y : -1
            };
            this.beliefs.setPartner(partnerInfo);
        }

        // Confirm partnership only for the selected partner
        if (senderId === this.beliefs.partnerId) {
            this.beliefs.partnerConfirmed = true;

            if (this.handshakeInterval) {
                clearInterval(this.handshakeInterval);
            }
        }
    }

    detectCoordinationMode() {
        // Decide mode only once (do not re-run after switching)
        if (this.mode !== COORDINATION_MODE.NORMAL) return;

        // Need a confirmed partner to coordinate
        if (!this.beliefs.partnerId || !this.beliefs.partnerConfirmed) {
            return;
        }

        const spawns = this.beliefs.environment.spawnerTiles;
        const deliveries = this.beliefs.environment.deliveryTiles;

        console.log(`[Coordination] Analyzing map: ${spawns.length} spawns, ${deliveries.length} deliveries`);

        // Analyze map connectivity to decide if a chokepoint warrants handover strategy
        const handoverConfig = this.handoverDetector.shouldUseHandover(spawns, deliveries);

        if (handoverConfig) {
            this.initializeHandoverMode(
                handoverConfig.spawnTile,
                handoverConfig.deliveryTile,
                handoverConfig.handoverTile,
                handoverConfig.reason
            );
        }
        else {
            console.log('[Coordination] Mode: NORMAL (zone-based coordination)');
        }
    }

    initializeHandoverMode(spawn, delivery, handover, reason) {
        // Store chosen handover configuration and switch mode
        this.mode = COORDINATION_MODE.HANDOVER;
        this.spawnTile = spawn;
        this.deliveryTile = delivery;
        this.handoverTile = handover;
        this.handoverReason = reason;

        console.log('[Coordination] ═══ HANDOVER MODE ENABLED ═══');
        console.log(`[Coordination] Reason: ${reason}`);
        console.log(`[Coordination] Spawn: (${spawn.x}, ${spawn.y})`);
        console.log(`[Coordination] Delivery: (${delivery.x}, ${delivery.y})`);
        console.log(`[Coordination] Handover: (${handover.x}, ${handover.y})`);

        // Decide whether we act as collector or courier
        this.assignHandoverRole();
    }

    assignHandoverRole() {
        // Role rule:
        // - Closer to spawn -> COLLECTOR (spawn -> handover)
        // - Closer to delivery -> COURIER (handover -> delivery)
        if (!this.beliefs.partnerId) {
            console.log('[Coordination] ⚠ No partner ID, cannot assign role');
            this.handoverRole = HANDOVER_ROLE.UNDECIDED;
            return;
        }

        // Need partner position to compare distances
        if (!this.beliefs.partnerPosition) {
            console.log('[Coordination] ⚠ Partner position not available yet, deferring role assignment');
            this.handoverRole = HANDOVER_ROLE.UNDECIDED;
            return;
        }

        const myId = this.beliefs.id;
        const partnerId = this.beliefs.partnerId;

        const myDistanceToSpawn = manhattanDistance(
            Math.floor(this.beliefs.x),
            Math.floor(this.beliefs.y),
            this.spawnTile.x,
            this.spawnTile.y
        );

        const partnerDistanceToSpawn = manhattanDistance(
            Math.floor(this.beliefs.partnerPosition.x),
            Math.floor(this.beliefs.partnerPosition.y),
            this.spawnTile.x,
            this.spawnTile.y
        );

        console.log(`[Coordination] Distance to spawn - Me: ${myDistanceToSpawn}, Partner: ${partnerDistanceToSpawn}`);

        if (myDistanceToSpawn < partnerDistanceToSpawn) {
            this.handoverRole = HANDOVER_ROLE.COLLECTOR;
        } else if (myDistanceToSpawn > partnerDistanceToSpawn) {
            this.handoverRole = HANDOVER_ROLE.COURIER;
        } else {
            // Tie-breaker ensures both agents end up with different roles
            this.handoverRole = (myId < partnerId) ? HANDOVER_ROLE.COLLECTOR : HANDOVER_ROLE.COURIER;
        }

        console.log(`[Coordination] ✓ Role assigned: ${this.handoverRole}`);

        this.announceHandoverRole();
    }

    async announceHandoverRole() {
        // Send role to partner so both agents can verify consistency
        if (!this.beliefs.partnerId) return;

        const msg = {
            header: 'HANDOVER_ROLE',
            content: {
                role: this.handoverRole,
                handoverTile: this.handoverTile
            }
        };

        await this.client.emitSay(msg, this.beliefs.partnerId);
    }

    handleHandoverRole(senderId, content) {
        // Only accept role messages from the chosen partner
        if (senderId !== this.beliefs.partnerId) return;

        this.partnerHandoverRole = content.role;

        // Sanity check: roles must be complementary
        if (this.partnerHandoverRole === this.handoverRole) {
            console.log(`[Coordination] ⚠⚠⚠ ROLE CONFLICT DETECTED! Both: ${this.handoverRole}`);
            console.log(`[Coordination] This should not happen with ID-based assignment!`);
        } else {
            console.log(`[Coordination] ✓ Role verification: Partner is ${this.partnerHandoverRole}, I am ${this.handoverRole}`);
        }
    }

    getHandoverConfig() {
        // Expose config only when handover is active and role is decided
        if (this.mode !== COORDINATION_MODE.HANDOVER) return null;
        if (this.handoverRole === HANDOVER_ROLE.UNDECIDED) return null;

        return {
            role: this.handoverRole,
            spawnTile: this.spawnTile,
            deliveryTile: this.deliveryTile,
            handoverTile: this.handoverTile,
            reason: this.handoverReason
        };
    }

    async shareParcels(parcels) {
        if (!this.beliefs.partnerId) return;
        const msg = new Message(MessageHeader.PARCEL_INFO, parcels);
        await this.client.emitShout(msg);
    }

    handleParcelInfo(parcels) {
        // Merge new parcels into beliefs (simple union by id)
        const knownParcels = this.beliefs.parcels;
        for (const parcel of parcels) {
            const exists = knownParcels.some(p => p.id === parcel.id);
            if (!exists) {
                knownParcels.push(parcel);
            }
        }
    }

    async shareAgents(agents) {
        if (!this.beliefs.partnerId) return;
        const msg = new Message(MessageHeader.AGENT_INFO, agents);
        await this.client.emitShout(msg);
    }

    handleAgentInfo(agents) {
        // Update agent positions in beliefs (used for collision/blocked checks)
        for (const agent of agents) {
            if (agent.id === this.beliefs.id) continue;

            const existingAgent = this.beliefs.agents.find(a => a.id === agent.id);
            if (existingAgent) {
                existingAgent.x = agent.x;
                existingAgent.y = agent.y;
            } else {
                this.beliefs.agents.push(agent);
            }
        }
    }

    async announceIntention(intention) {
        if (!this.beliefs.partnerId) return;
        this.myIntention = intention;
        const msg = new Message(MessageHeader.INTENTION, intention);
        await this.client.emitSay(msg, this.beliefs.partnerId);
    }

    handleIntention(senderId, intention) {
        if (senderId !== this.beliefs.partnerId) return;
        this.partnerIntention = intention;
    }

    hasIntentionConflict() {
        // Conflict when both are targeting the same parcel
        if (!this.myIntention || !this.partnerIntention) return false;
        return this.myIntention.parcelId === this.partnerIntention.parcelId;
    }

    shouldYieldIntention() {
        // Yield if partner has higher utility; on tie, yield to lower partnerId (deterministic)
        if (!this.hasIntentionConflict()) return false;

        const myUtility = this.myIntention.utility || 0;
        const partnerUtility = this.partnerIntention.utility || 0;

        if (partnerUtility > myUtility) return true;
        if (partnerUtility === myUtility && this.beliefs.partnerId < this.beliefs.id) return true;

        return false;
    }

    clearIntention() {
        this.myIntention = null;
    }

    detectCollision(targetX, targetY) {
        // Collision risk if our intended next cell equals partner's current cell
        if (!this.beliefs.partnerId) return false;

        const partner = this.beliefs.getPartner();
        if (!partner) return false;

        const partnerX = Math.floor(partner.x);
        const partnerY = Math.floor(partner.y);

        return partnerX === targetX && partnerY === targetY;
    }

    async initiateCollisionResolution(context) {
        // If already in collision state, wait unless timed out
        if (this.collisionState.active) {
            const elapsed = Date.now() - this.collisionState.startTime;

            if (elapsed > this.beliefs.config.MOVEMENT_DURATION * 2) {
                console.log(`[Coordination]  Collision timeout after ${elapsed}ms, resetting`);
                this.exitCollisionState();
            } else {
                return;
            }
        }

        // Initiator asks partner to move out of the way
        this.collisionState = {
            active: true,
            initiator: true,
            phase: 'requesting',
            waitingFor: 'MOVED',
            context: context,
            startTime: Date.now()
        };

        console.log('[Coordination] ═══ COLLISION DETECTED ═══');

        const msg = new Message(MessageHeader.COLLISION, {
            type: 'MOVE',
            reason: 'blocking_path'
        });

        await this.client.emitSay(msg, this.beliefs.partnerId);
    }

    async handleCollision(senderId, content) {
        // Only accept collision protocol messages from partner
        if (senderId !== this.beliefs.partnerId) return;

        switch (content.type) {
            case 'MOVE': {
                // If both sides initiate at once, apply deterministic priority by id
                const iAmInitiatorWaiting =
                    this.collisionState.active &&
                    this.collisionState.initiator &&
                    this.collisionState.waitingFor === 'MOVED';

                if (iAmInitiatorWaiting && senderId > this.beliefs.id) {
                    console.log('[Coordination] I have priority, waiting for partner to move');
                    return;
                }

                await this.handleMoveRequest();
                break;
            }
            case 'MOVED':
                this.handleMoved(content);
                break;
            case 'END':
                this.handleEnd();
                break;
        }
    }

    async handleMoveRequest() {
        // Receiver of MOVE request tries to step into a nearby free reachable cell
        this.collisionState = {
            active: true,
            initiator: false,
            phase: 'moving',
            waitingFor: 'END',
            context: null,
            startTime: Date.now()
        };

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        const freeCell = this.findAdjacentFreeCell(current_x, current_y);

        if (!freeCell) {
            console.log('[Coordination] No free cell to move to, ending collision');
            await this.endCollision();
            return;
        }

        const direction = this.getAction(current_x, current_y, freeCell.x, freeCell.y);
        await this.client.emitMove(direction);
        await this.sleep(this.beliefs.config.MOVEMENT_DURATION);

        // Notify initiator that we moved out of the way
        const msg = new Message(MessageHeader.COLLISION, {
            type: 'MOVED',
            newPos: freeCell
        });

        await this.client.emitSay(msg, this.beliefs.partnerId);
    }

    handleMoved(content) {
        // Initiator can proceed once partner reports a successful move
        if (this.collisionState.initiator) {
            console.log('[Coordination] Partner moved, collision resolved');
            this.collisionState.phase = 'proceeding';
            this.collisionState.waitingFor = null;
        }
    }

    handleEnd() {
        console.log('[Coordination] Collision resolution ended');
        this.exitCollisionState();
    }

    async endCollision() {
        if (!this.collisionState.active) return;

        const msg = new Message(MessageHeader.COLLISION, { type: 'END' });
        await this.client.emitSay(msg, this.beliefs.partnerId);

        this.exitCollisionState();
    }

    exitCollisionState() {
        this.collisionState = {
            active: false,
            initiator: false,
            phase: null,
            waitingFor: null,
            context: null,
            startTime: 0
        };
    }

    findAdjacentFreeCell(x, y) {
        // Scan 4-neighborhood for a reachable cell not occupied by another agent
        const adjacent = [
            { x: x + 1, y: y },
            { x: x - 1, y: y },
            { x: x, y: y + 1 },
            { x: x, y: y - 1 }
        ];

        for (const cell of adjacent) {
            if (!this.beliefs.environment.isReachable(cell.x, cell.y)) continue;

            const blocked = this.beliefs.agents.some(
                agent => agent.id !== this.beliefs.id &&
                        Math.floor(agent.x) === cell.x &&
                        Math.floor(agent.y) === cell.y
            );

            if (!blocked) return cell;
        }

        return null;
    }

    getAction(fromX, fromY, toX, toY) {
        const dx = toX - fromX;
        const dy = toY - fromY;

        if (dx === 1) return 'right';
        if (dx === -1) return 'left';
        if (dy === 1) return 'up';
        if (dy === -1) return 'down';

        return null;
    }

    async sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    getPartnerId() {
        return this.beliefs.partnerId;
    }

    isInCollision() {
        // Auto-reset if collision protocol gets stuck
        if (this.collisionState.active) {
            const elapsed = Date.now() - this.collisionState.startTime;
            if (elapsed > this.beliefs.config.MOVEMENT_DURATION * 2) {
                console.log(`[Coordination] Collision state stuck for ${elapsed}ms, auto-resetting`);
                this.exitCollisionState();
                return false;
            }
        }

        return this.collisionState.active;
    }

    isHandoverMode() {
        return this.mode === COORDINATION_MODE.HANDOVER;
    }

    reset() {
        this.beliefs.clearPartner();
        this.mode = COORDINATION_MODE.NORMAL;
        this.handoverReason = null;
        this.exitCollisionState();
        this.myIntention = null;
        this.partnerIntention = null;
        this.handoverRole = HANDOVER_ROLE.UNDECIDED;
        this.partnerHandoverRole = null;

        if (this.handshakeInterval) {
            clearInterval(this.handshakeInterval);
        }
    }

    destroy() {
        if (this.handshakeInterval) {
            clearInterval(this.handshakeInterval);
        }
    }
}
