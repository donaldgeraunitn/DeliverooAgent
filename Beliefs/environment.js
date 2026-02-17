import { Tile } from './tile.js';
import { manhattanDistance } from '../Utils/utils.js';

export class Environment {
    constructor() {
        // Grid dimensions
        this.width = 0;
        this.height = 0;

        // 2D grid of Tile objects: map[y][x]
        this.map = [];

        // Precomputed tile lists for fast access in planners
        this.deliveryTiles = [];
        this.spawnerTiles = [];
        this.normalTiles = [];
    }

    init(width, height, tiles) {
        // Build an empty grid of Tile instances
        this.width = width;
        this.height = height;

        this.map = Array.from({ length: height }, (_, y) =>
            Array.from({ length: width }, (_, x) => new Tile(x, y, false, false, false))
        );

        this.deliveryTiles = [];
        this.spawnerTiles = [];
        this.normalTiles = [];

        // type 1 = spawner, type 2 = delivery, type 3 = reachable
        for (const tile of tiles) {
            if (tile.type === 1) { // spawner
                this.setSpawner(tile.x, tile.y, true);
                this.setReachable(tile.x, tile.y, true);
                this.spawnerTiles.push(this.map[tile.y][tile.x]);
            }
            else if (tile.type === 2) { // delivery
                this.setDelivery(tile.x, tile.y, true);
                this.setReachable(tile.x, tile.y, true);
                this.deliveryTiles.push(this.map[tile.y][tile.x]);
            }
            else if (tile.type === 3) { // reachable
                this.setReachable(tile.x, tile.y, true);
                this.normalTiles.push(this.map[tile.y][tile.x]);
            }
        }

        // Precompute 4-neighborhood adjacency for pathfinding/exploration
        this.buildNeighbors();
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
        if (this.isValid(x, y)) return this.map[y][x];
        else return null;
    }

    isValid(x, y) {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }

    isReachable(x, y) {
        // Reachable means reachable
        // const isBlocked = agents.some(agent => agent.id !== id && Math.floor(agent.x) === x && Math.floor(agent.y) === y);
        return this.isValid(x, y) && this.map[y][x].reachable;
    }

    isDelivery(x, y) {
        return this.isValid(x, y) && this.map[y][x].delivery;
    }

    isSpawner(x, y) {
        return this.isValid(x, y) && this.map[y][x].spawner;
    }

    buildNeighbors() {
        // 4-connected grid: down, up, right, left
        const directions = [ { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 } ];

        // For each tile, compute its reachable neighbors once and store them in Tile
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const tile = this.map[y][x];

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

    compareTiles(a, b) {
        // Deterministic ordering (useful for stable tie-breaking)
        if (a.x !== b.x) return a.x - b.x;
        return a.y - b.y;
    }

    pickFarthestFrom(start, candidates) {
        // Greedy helper: among candidates, pick the farthest from "start" (Manhattan)
        // Tie-break deterministically by coordinate ordering
        let best = candidates[0];
        let bestDistance = -1;

        for (let i = 0; i < candidates.length; i++) {
            const distance = manhattanDistance(start.x, start.y, candidates[i].x, candidates[i].y);
            if (distance > bestDistance || (distance === bestDistance && this.compareTiles(candidates[i], best) < 0)) {
                bestDistance = distance;
                best = candidates[i];
            }
        }
        return best;
    }

    pickSeedPair(candidates, config) {
        // Select two seed tiles to initialize a 2-way partitioning of spawners.
        // - If candidates are many, use a fast heuristic (two farthest hops).
        // - If candidates are few, compute exact farthest pair (O(n^2)).
        const limit = config.PARTITION_LIMIT;

        if (candidates.length > limit) {
            const a = candidates[0];
            const first = this.pickFarthestFrom(a, candidates);
            const second = this.pickFarthestFrom(first, candidates);
            return [first, second];
        }

        let seedA = candidates[0];
        let seedB = candidates[1];
        let bestDistance = -Infinity;

        for (let i = 0; i < candidates.length; i++) {
            for (let j = i + 1; j < candidates.length; j++) {
                const distance = manhattanDistance(candidates[i].x, candidates[i].y, candidates[j].x, candidates[j].y);
                if (distance > bestDistance) {
                    bestDistance = distance;
                    seedA = candidates[i];
                    seedB = candidates[j];
                }
            }
        }
        return [seedA, seedB];
    }

    getClosestDeliveryTile(x, y, bannedTiles) {
        // Choose closest delivery tile by Manhattan distance
        let closestTile = null;
        let minDistance = Infinity;

        for (const tile of this.deliveryTiles) {
            const tileKey = tile.tileKey();

            if (bannedTiles && bannedTiles.isBanned(tileKey)) {
                console.log(`[Environment] - Skipping banned delivery tile (${tile.x}, ${tile.y})`);
                continue;
            }

            const distance = manhattanDistance(x, y, tile.x, tile.y);
            if (distance < minDistance) {
                minDistance = distance;
                closestTile = tile;
            }
        }

        return closestTile;
    }

    assignBalanced(seedA, seedB, allTiles) {
        // Create two clusters with (nearly) equal size:
        // - Each tile is assigned to its closer seed.
        // - If a cluster is full, overflow goes to the other cluster.
        // - Assignment order is “most confident first” to reduce bad early choices.
        const targetA = Math.ceil(allTiles.length / 2);
        const targetB = allTiles.length - targetA;

        const firstCluster = [seedA];
        const secondCluster = [seedB];

        const remaining = allTiles.filter(tile => tile !== seedA && tile !== seedB);

        // Score each tile by distances to seeds + confidence = |dA - dB|
        const scored = [];
        for (let r = 0; r < remaining.length; r++) {
            const tile = remaining[r];
            const distanceA = manhattanDistance(tile.x, tile.y, seedA.x, seedA.y);
            const distanceB = manhattanDistance(tile.x, tile.y, seedB.x, seedB.y);
            scored.push({
                tile: tile,
                distanceA: distanceA,
                distanceB: distanceB,
                confidence: Math.abs(distanceA - distanceB),
                preferA: distanceA <= distanceB
            });
        }

        // Sort assignment priority:
        // 1) high confidence first (clear preference),
        // 2) then prefer tiles that are close to some seed,
        // 3) tie-breaker
        scored.sort((p, q) => {
            if (q.confidence !== p.confidence) return q.confidence - p.confidence;

            const pBest = Math.min(p.distanceA, p.distanceB);
            const qBest = Math.min(q.distanceA, q.distanceB);
            if (pBest !== qBest) return pBest - qBest;

            return this.compareTiles(p.tile, q.tile);
        });

        // Balanced fill with preference, respecting target sizes
        for (let s = 0; s < scored.length; s++) {
            const item = scored[s];

            if (item.preferA) {
                if (firstCluster.length < targetA) firstCluster.push(item.tile);
                else secondCluster.push(item.tile);
            }
            else {
                if (secondCluster.length < targetB) secondCluster.push(item.tile);
                else firstCluster.push(item.tile);
            }
        }

        return { firstCluster: firstCluster, secondCluster: secondCluster };
    }

    partitionMap(config) {
        // Partition spawner tiles into two “zones” for coordination
        const tiles = this.spawnerTiles;
        const total = tiles.length;

        if (total === 0) {
            return { firstCluster: [], secondCluster: [] };
        }
        if (total === 1) {
            return { firstCluster: [tiles[0]], secondCluster: [] };
        }

        // Pick two far-apart seeds to maximize separation between clusters
        const seeds = this.pickSeedPair(tiles, config);
        let seedA = seeds[0];
        let seedB = seeds[1];

        // Assign all spawner tiles into two balanced clusters around the seeds
        let firstCluster = [];
        let secondCluster = [];

        const assigned = this.assignBalanced(seedA, seedB, tiles);
        firstCluster = assigned.firstCluster;
        secondCluster = assigned.secondCluster;

        return { firstCluster: firstCluster, secondCluster: secondCluster };
    }
}
