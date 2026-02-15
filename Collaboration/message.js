export const MessageHeader = {
    HANDSHAKE: 'HANDSHAKE',
    HANDSHAKE_ACK: 'HANDSHAKE_ACK',
    PARCEL_INFO: 'PARCEL_INFO',
    AGENT_INFO: 'AGENT_INFO',
    INTENTION: 'INTENTION',
    COLLISION: 'COLLISION',
    HANDOVER_ROLE: 'HANDOVER_ROLE'
};

export class Message {
    constructor(header, content, sender) {
        this.header = header;
        this.content = content;
        this.sender = sender;
    }
}