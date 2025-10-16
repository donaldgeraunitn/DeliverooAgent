export class Tile {
    constructor(x, y, delivery, spawner, reachable) {
        this.x = x;
        this.y = y;
        this.delivery = delivery;
        this.spawner = spawner;
        this.reachable = reachable;
        this.neighbors = [];
    }

    setNeighbors(neighbors) {
        this.neighbors = neighbors;
    }

    getNeighbors() {
        return this.neighbors;
    }
}