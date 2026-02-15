import { Message, MessageHeader } from './message.js';
import { HandoverDetector } from './handover_detector.js';
import { manhattanDistance } from '../Util/utils.js';

const COORDINATION_MODE = {
    NORMAL: 'NORMAL',
    HANDOVER: 'HANDOVER'
};

const HANDOVER_ROLE = {
    COLLECTOR: 'COLLECTOR',
    COURIER: 'COURIER',
    UNDECIDED: 'UNDECIDED'
};

const COLLISION_TIMEOUT = 500;

export class Coordination {
    constructor(client, beliefs, pathfinding) {
        this.client = client;
        this.beliefs = beliefs;
        this.pathfinding = pathfinding;
        
        this.handoverDetector = new HandoverDetector(beliefs, pathfinding);
        
        this.mode = COORDINATION_MODE.NORMAL;
        this.handoverReason = null;
        
        this.collisionState = {
            active: false,
            initiator: false,
            phase: null,
            waitingFor: null,
            context: null,
            startTime: 0
        };
        
        this.myIntention = null;
        this.partnerIntention = null;
        
        this.handoverRole = HANDOVER_ROLE.UNDECIDED;
        this.partnerHandoverRole = null;
        this.spawnTile = null;
        this.deliveryTile = null;
        this.handoverTile = null;
        
        this.setupListener();
    }

    setupListener() {
        this.client.onMsg((id, name, msg, reply) => {
            if (id === this.beliefs.id) return;
            this.handleMessage(id, msg);
        });
    }

    handleMessage(senderId, msg) {
        switch (msg.header) {
            case MessageHeader.HANDSHAKE:
                this.handleHandshake(senderId, msg);
                break;
            case MessageHeader.HANDSHAKE_ACK:
                this.handleHandshakeAck(senderId, msg);  // ✅ Pass full message
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

    // ========================================================================
    // PARTNER DISCOVERY
    // ========================================================================

    async startPartnerDiscovery() {
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
        const msg = new Message(MessageHeader.HANDSHAKE, 'request_partner', { id: this.beliefs.id , x: this.beliefs.x, y: this.beliefs.y } );
        await this.client.emitShout(msg);
    }

    async handleHandshake(id, message) {
        if (this.beliefs.hasPartner()) return;
        
        this.beliefs.setPartner( { id: message.sender.id, x: message.sender.x, y: message.sender.y });
        
        const ack = new Message(MessageHeader.HANDSHAKE_ACK, 'partner_accepted', { id: this.beliefs.id, x: this.beliefs.x, y: this.beliefs.y });
        await this.client.emitSay(ack, id);
        
        console.log(`[Coordination] Partnership established with ${id}`);
        
        if (this.handshakeInterval) {
            clearInterval(this.handshakeInterval);
        }
    }

    handleHandshakeAck(senderId, msg) {
        if (!this.beliefs.partnerId) {
            // Extract position from sender field
            const partnerInfo = {
                id: senderId,
                x: msg.sender ? msg.sender.x : -1,
                y: msg.sender ? msg.sender.y : -1
            };
            this.beliefs.setPartner(partnerInfo);
        }
        
        if (senderId === this.beliefs.partnerId) {
            this.beliefs.partnerConfirmed = true;
            
            if (this.handshakeInterval) {
                clearInterval(this.handshakeInterval);
            }
        }
    }

    // ========================================================================
    // SMART COORDINATION MODE DETECTION
    // ========================================================================

    detectCoordinationMode() {
        if (this.mode !== COORDINATION_MODE.NORMAL) return;
        
        if (!this.beliefs.partnerId || !this.beliefs.partnerConfirmed) {
            return;
        }
        
        const spawns = this.beliefs.environment.spawnerTiles;
        const deliveries = this.beliefs.environment.deliveryTiles;
        
        console.log(`[Coordination] Analyzing map: ${spawns.length} spawns, ${deliveries.length} deliveries`);
        
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
        
        this.assignHandoverRole();
    }

    assignHandoverRole() {
        // POSITION-BASED ASSIGNMENT
        // Agent closer to spawn → COLLECTOR (spawn → handover)
        // Agent closer to delivery → COURIER (handover → delivery)
        
        if (!this.beliefs.partnerId) {
            console.log('[Coordination] ⚠ No partner ID, cannot assign role');
            this.handoverRole = HANDOVER_ROLE.UNDECIDED;
            return;
        }
        
        // Check if we have partner's position
        if (!this.beliefs.partnerPosition) {
            console.log('[Coordination] ⚠ Partner position not available yet, deferring role assignment');
            this.handoverRole = HANDOVER_ROLE.UNDECIDED;
            return;
        }
        
        const myId = this.beliefs.id;
        const partnerId = this.beliefs.partnerId;

        // Calculate distances using correct manhattanDistance signature
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
        
        // Assign role based on distance (with ID tie-breaker)
        if (myDistanceToSpawn < partnerDistanceToSpawn) {
            this.handoverRole = HANDOVER_ROLE.COLLECTOR;
        } else if (myDistanceToSpawn > partnerDistanceToSpawn) {
            this.handoverRole = HANDOVER_ROLE.COURIER;
        } else {
            // Equal distance: use ID as tie-breaker
            this.handoverRole = (myId < partnerId) ? HANDOVER_ROLE.COLLECTOR : HANDOVER_ROLE.COURIER;
        }
        
        console.log(`[Coordination] ✓ Role assigned: ${this.handoverRole}`);
        
        this.announceHandoverRole();
    }

    async announceHandoverRole() {
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
        if (senderId !== this.beliefs.partnerId) return;
        
        this.partnerHandoverRole = content.role;
        
        if (this.partnerHandoverRole === this.handoverRole) {
            console.log(`[Coordination] ⚠⚠⚠ ROLE CONFLICT DETECTED! Both: ${this.handoverRole}`);
            console.log(`[Coordination] This should not happen with ID-based assignment!`);
        } else {
            console.log(`[Coordination] ✓ Role verification: Partner is ${this.partnerHandoverRole}, I am ${this.handoverRole}`);
        }
    }

    getHandoverConfig() {
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
        if (!this.myIntention || !this.partnerIntention) return false;
        return this.myIntention.parcelId === this.partnerIntention.parcelId;
    }

    shouldYieldIntention() {
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
        if (!this.beliefs.partnerId) return false;
        
        const partner = this.beliefs.getPartner();
        if (!partner) return false;
        
        const partnerX = Math.floor(partner.x);
        const partnerY = Math.floor(partner.y);
        
        return partnerX === targetX && partnerY === targetY;
    }

    async initiateCollisionResolution(context) {
        if (this.collisionState.active) {
            const elapsed = Date.now() - this.collisionState.startTime;
            
            if (elapsed > COLLISION_TIMEOUT) {
                console.log(`[Coordination]  Collision timeout after ${elapsed}ms, resetting`);
                this.exitCollisionState();
            } else {
                return;
            }
        }
        
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
        if (senderId !== this.beliefs.partnerId) return;

        switch (content.type) {
            case 'MOVE': {
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
        
        const direction = this.getDirection(current_x, current_y, freeCell.x, freeCell.y);
        await this.client.emitMove(direction);
        await this.sleep(this.beliefs.config.MOVEMENT_DURATION);
        
        const msg = new Message(MessageHeader.COLLISION, {
            type: 'MOVED',
            newPos: freeCell
        });
        
        await this.client.emitSay(msg, this.beliefs.partnerId);
    }

    handleMoved(content) {
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

    getDirection(fromX, fromY, toX, toY) {
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
        if (this.collisionState.active) {
            const elapsed = Date.now() - this.collisionState.startTime;
            if (elapsed > COLLISION_TIMEOUT) {
                console.log(`[Coordination] ⚠ Collision state stuck for ${elapsed}ms, auto-resetting`);
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