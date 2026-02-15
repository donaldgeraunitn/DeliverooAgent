/**
 * Handover Detection
 * Determines when handover mode should be used based on:
 * - Bottleneck detection: checks if there's truly only one path (or narrow passage)
 *   from spawners to deliveries with NO alternative routes available
 */
import { tileKey, manhattanDistance } from "../Util/utils.js";

export class HandoverDetector {
    constructor(beliefs, pathfinding) {
        this.beliefs = beliefs;
        this.pathfinding = pathfinding;
    }

    shouldUseHandover(spawns, deliveries) {
        console.log('[HandoverDetector] - Analyzing map for bottleneck...');

        // Detect bottleneck (true single-path scenario with no alternatives)
        const bottleneckResult = this.detectBottleneck(spawns, deliveries);
        
        if (!bottleneckResult) {
            console.log('[HandoverDetector] - No bottleneck found, using normal mode');
            return null;
        }

        console.log('[HandoverDetector] - Bottleneck detected at', bottleneckResult.handoverTile);

        // Final sanity check: handover must be feasible on the static map
        if (!this.isHandoverPointFeasible(bottleneckResult.spawnTile, bottleneckResult.deliveryTile, bottleneckResult.handoverTile)) {
            console.log('[HandoverDetector] - Candidate handover point not feasible, using normal mode');
            return null;
        }

        return bottleneckResult;
    }

    detectBottleneck(spawns, deliveries) {
        // Build ALL paths from each spawn to each delivery
        const allPaths = [];
        
        for (const spawn of spawns) {
            for (const delivery of deliveries) {
                const path = this.pathfinding.AStar(
                    spawn.x, spawn.y,
                    delivery.x, delivery.y,
                    { ignoreAgents: true }
                );
                
                if (path.length > 0) {
                    allPaths.push({ path, spawn, delivery });
                }
            }
        }
        
        if (allPaths.length === 0) {
            console.log('[HandoverDetector] No paths found');
            return null;
        }
        
        console.log(`[HandoverDetector] Found ${allPaths.length} total paths`);
        
        // Find tiles that appear in ALL paths
        const tileCounts = new Map();
        
        for (const { path } of allPaths) {
            const seenInThisPath = new Set();
            
            for (const tile of path) {
                const key = tileKey(tile.x, tile.y);
                if (!seenInThisPath.has(key)) {
                    seenInThisPath.add(key);
                    tileCounts.set(key, (tileCounts.get(key) || 0) + 1);
                }
            }
        }
        
        // Get tiles that appear in ALL paths (true bottleneck)
        const bottleneckTiles = [];
        for (const [key, count] of tileCounts.entries()) {
            if (count === allPaths.length) {
                const [x, y] = key.split(',').map(Number);
                bottleneckTiles.push({ x, y, key });
            }
        }
        
        if (bottleneckTiles.length === 0) {
            console.log('[HandoverDetector] No common tiles in all paths - multiple routes exist');
            return null;
        }
        
        console.log(`[HandoverDetector] Found ${bottleneckTiles.length} tiles common to all paths`);
        
        // Additional check: must be a narrow passage (not just a large open area)
        const narrowBottlenecks = bottleneckTiles.filter(tile => {
            const neighbors = this.beliefs.environment.map[tile.y][tile.x].getNeighbors();
            return neighbors.length <= 2; // True corridor/chokepoint
        });
        
        if (narrowBottlenecks.length === 0) {
            console.log('[HandoverDetector] Common tiles exist but area is not narrow - no bottleneck');
            return null;
        }
        
        console.log(`[HandoverDetector] Confirmed bottleneck: ${narrowBottlenecks.length} narrow chokepoints`);
        
        // Use representative spawn/delivery
        const representativeSpawn = this.findClosestTile(spawns, this.calculateCentroid(spawns));
        const representativeDelivery = this.findClosestTile(deliveries, this.calculateCentroid(deliveries));
        
        if (!representativeSpawn || !representativeDelivery) return null;
        
        // Select best handover point from bottleneck tiles
        const primaryPath = this.pathfinding.AStar(
            representativeSpawn.x, representativeSpawn.y,
            representativeDelivery.x, representativeDelivery.y,
            { ignoreAgents: true }
        );
        
        const midpointIndex = Math.floor(primaryPath.length / 2);
        const idealMidpoint = primaryPath[midpointIndex];
        
        let bestHandover = narrowBottlenecks[0];
        let bestDistance = manhattanDistance(idealMidpoint.x, idealMidpoint.y, bestHandover.x, bestHandover.y);
        
        for (const tile of narrowBottlenecks) {
            const distance = manhattanDistance(idealMidpoint.x, idealMidpoint.y, tile.x, tile.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestHandover = tile;
            }
        }
        
        console.log(`[HandoverDetector] Selected handover point at (${bestHandover.x}, ${bestHandover.y})`);
        
        // Determine if it's single-path or bottleneck
        const isSinglePath = bottleneckTiles.length >= primaryPath.length * 0.8;
        
        return {
            spawnTile: representativeSpawn,
            deliveryTile: representativeDelivery,
            handoverTile: bestHandover,
            reason: isSinglePath ? 'single_path' : 'bottleneck'
        };
    }

    calculateCentroid(tiles) {
        if (tiles.length === 0) return { x: 0, y: 0 };

        const sumX = tiles.reduce((sum, tile) => sum + tile.x, 0);
        const sumY = tiles.reduce((sum, tile) => sum + tile.y, 0);

        return { 
            x: Math.round(sumX / tiles.length), 
            y: Math.round(sumY / tiles.length) 
        };
    }

    findClosestTile(tiles, position) {
        if (tiles.length === 0) return null;

        let closest = tiles[0];
        let minDistance = manhattanDistance(tiles[0].x, tiles[0].y, position.x, position.y);

        for (const tile of tiles) {
            const dist = manhattanDistance(tile.x, tile.y, position.x, position.y);
            if (dist < minDistance) {
                minDistance = dist;
                closest = tile;
            }
        }

        return closest;
    }

    isHandoverPointFeasible(spawnTile, deliveryTile, handoverTile) {
        if (!spawnTile || !deliveryTile || !handoverTile) return false;

        const hx = handoverTile.x;
        const hy = handoverTile.y;

        // Check if handover tile is reachable
        if (!this.beliefs.environment.isReachable(hx, hy)) return false;

        // Handover point needs at least 2 neighbors for agents to pass through
        const reachableAdj = this.beliefs.environment.map[hy][hx].getNeighbors();
        if (reachableAdj.length < 2) return false;

        // Verify paths exist from spawn to handover and from handover to delivery
        const toHandover = this.pathfinding.AStar(spawnTile.x, spawnTile.y, hx, hy, { ignoreAgents: true });
        const fromHandover = this.pathfinding.AStar(hx, hy, deliveryTile.x, deliveryTile.y, { ignoreAgents: true });
        
        return toHandover.length > 0 && fromHandover.length > 0;
    }
}