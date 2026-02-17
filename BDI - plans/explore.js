import { Plan } from "./plan.js";
import { BanList } from "../Utils/banlist.js";
import { tileKey } from "../Utils/utils.js";

export class Explore extends Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        super(beliefs, pathfinding, coordination);

        // Per-tile visit counter: key("x,y") -> number of times we've been there
        this.visits = new Map();

        // Temporary bans for unreachable / repeatedly failing targets
        this.bans = new BanList(this.beliefs.config.BAN_DURATION);
    }

    recordPosition(x, y) {
        // Update visit statistics for the current tile
        const key = tileKey(x, y);
        this.visits.set(key, (this.visits.get(key) || 0) + 1);
    }

    selectLeastVisited(current_x, current_y, candidateTiles) {
        // Choose the least-visited candidate tile; tie-break by heuristic distance
        let selectedTile = null;
        let minVisitCount = Infinity;
        let minDistance = Infinity;

        for (const tile of candidateTiles) {
            const key = tileKey(tile.x, tile.y);

            // Skip temporarily banned targets (e.g., previously unreachable)
            if (this.bans.isBanned(key)) continue;

            const visitCount = this.visits.get(key) || 0;
            const distance = this.pathfinding.heuristic(current_x, current_y, tile.x, tile.y);

            // Primary criterion: fewer visits; secondary: closer target
            const isBetter =
                visitCount < minVisitCount ||
                (visitCount === minVisitCount && distance < minDistance);

            if (isBetter) {
                minVisitCount = visitCount;
                minDistance = distance;
                selectedTile = tile;
            }
        }

        return selectedTile;
    }

    getTarget(current_x, current_y) {
        // Prefer exploring spawner tiles (higher chance to discover parcels)
        let spawnerTiles = this.beliefs.environment.spawnerTiles;

        // If assigned a zone (coordination), restrict exploration to that zone’s spawners
        if (this.beliefs.myArea && this.beliefs.myArea.length > 0) {
            spawnerTiles = spawnerTiles.filter(spawner =>
                this.beliefs.myArea.some(tile => tile.x === spawner.x && tile.y === spawner.y)
            );

            // Fallback: if zone contains no spawners, explore all spawners
            if (spawnerTiles.length === 0) {
                console.log("[Explore] No spawners in my zone, exploring all");
                spawnerTiles = this.beliefs.environment.spawnerTiles;
            }
        }

        // First attempt: least-visited spawner tile
        const spawnerCandidate = this.selectLeastVisited(current_x, current_y, spawnerTiles);
        if (spawnerCandidate) return spawnerCandidate;

        // Fallback: least-visited normal tile to keep coverage when no spawner is selectable
        const normalTiles = this.beliefs.environment.normalTiles;
        return this.selectLeastVisited(current_x, current_y, normalTiles);
    }

    getAction() {
        // Advance ban timers each tick
        this.bans.incrementTime();

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        // Defensive guard for uninitialized belief position
        if (current_x === -1 && current_y === -1) return null;

        // Record visit to support least-visited exploration strategy
        this.recordPosition(current_x, current_y);

        // If we already have a path, keep following it
        if (this.path.length > 0) {
            const move = this.followPath(current_x, current_y);
            if (move) return move;
            else this.clearPath();
        }

        // Pick a new exploration target
        const targetTile = this.getTarget(current_x, current_y);
        if (!targetTile) {
            this.fail("No explorable tiles available");
            return null;
        }

        // Plan a path to the chosen target
        this.ensurePath(current_x, current_y, targetTile.x, targetTile.y);

        // If unreachable, ban it temporarily to avoid repeatedly selecting it
        if (this.path.length === 0) {
            console.log(`[Explore] No path to (${targetTile.x}, ${targetTile.y}), banning tile`);
            this.bans.ban(tileKey(targetTile.x, targetTile.y));
            this.fail("No path to exploration target");
            this.clearPath();
            return null;
        }

        // Execute the next step toward the target
        return this.followPath(current_x, current_y);
    }
}
