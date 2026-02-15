export class BanList {
    constructor(duration) {
        this.duration = duration;
        this.timer = 0;
        this.banned = new Map();
    }

    incrementTime() {
        this.timer += 1;
        this.cleanup();
    }

    cleanup() {
        const toRemove = [];

        for (const [key, until] of this.banned.entries()) {
            if (this.timer >= until) toRemove.push(key);
        }

        for (const key of toRemove) this.banned.delete(key);
    }

    isBanned(key) {
        const until = this.banned.get(key);
        return until !== undefined && until > this.timer;
    }

    ban(key) {
        this.banned.set(key, this.timer + this.duration);
    }
}