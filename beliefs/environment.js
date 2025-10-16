import { Tile } from './tile.js';
import { manhattanDistance } from '../utils/utils.js';

export class Environment {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.map = [];
        this.deliveryTiles = [];
        this.spawnerTiles = [];
        this.ready = false;
    }

    init(width, height, tiles) {
        this.width = width;
        this.height = height;

        // Initialize map with all tiles
        this.map = Array.from({ length: height }, (_, y) =>
            Array.from({ length: width }, (_, x) => new Tile(x, y, false, false, false))
        );

        this.deliveryTiles = [];
        this.spawnerTiles = [];

        // Process tiles from server
        for (const t of tiles) {
            if (t.type === 2) {
                // Delivery zone
                this.setDelivery(t.x, t.y, true);
                this.setReachable(t.x, t.y, true);
                this.deliveryTiles.push({ x: t.x, y: t.y });
            } 
            else if (t.type === 1) {
                // Spawner zone
                this.setSpawner(t.x, t.y, true);
                this.setReachable(t.x, t.y, true);
                this.spawnerTiles.push({ x: t.x, y: t.y });
            } 
            else if (t.type === 3) {
                // Walkable tile
                this.setReachable(t.x, t.y, true);
            }
        }

        // Build neighbor relationships for pathfinding
        this.buildNeighbors();
        this.ready = true;
    }

    setDelivery(x, y, value) {
        if (this.isValid(x, y)) {
            this.map[y][x].delivery = value;
        }
    }

    setSpawner(x, y, value) {
        if (this.isValid(x, y)) {
            this.map[y][x].spawner = value;
        }
    }

    setReachable(x, y, value) {
        if (this.isValid(x, y)) {
            this.map[y][x].reachable = value;
        }
    }

    getTile(x, y) {
        if (this.isValid(x, y)) {
            return this.map[y][x];
        }
        return null;
    }

    isValid(x, y) {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }

    isReachable(x, y) {
        return this.isValid(x, y) && this.map[y][x].reachable;
    }

    isDelivery(x, y) {
        return this.isValid(x, y) && this.map[y][x].delivery;
    }

    isSpawner(x, y) {
        return this.isValid(x, y) && this.map[y][x].spawner;
    }

    // Build neighbor relationships for each tile
    buildNeighbors() {
        const directions = [
            { dx: 0, dy: 1 },   // down
            { dx: 0, dy: -1 },  // up
            { dx: 1, dy: 0 },   // right
            { dx: -1, dy: 0 }   // left
        ];

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const tile = this.map[y][x];
                if (!tile.reachable) continue;

                const neighbors = [];
                for (const dir of directions) {
                    const nx = x + dir.dx;
                    const ny = y + dir.dy;
                    if (this.isReachable(nx, ny)) {
                        neighbors.push(this.map[ny][nx]);
                    }
                }
                tile.setNeighbors(neighbors);
            }
        }
    }

    // Find closest delivery tile to a position
    getClosestDeliveryTile(x, y) {
        let closestTile = null;
        let minDistance = Infinity;

        for (const deliveryPos of this.deliveryTiles) {
            const distance = manhattanDistance(x, y, deliveryPos.x, deliveryPos.y);
            if (distance < minDistance) {
                minDistance = distance;
                closestTile = deliveryPos;
            }
        }

        return closestTile;
    }
}