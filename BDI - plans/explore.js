import { Plan } from "./plan.js";
import { BanList } from "../Utils/banlist.js";
import { tileKey } from "../Utils/utils.js";

export class Explore extends Plan {
    constructor(beliefs, pathfinding, coordination = null) {
        super(beliefs, pathfinding, coordination);

        this.visits = new Map();
        this.bans = new BanList(this.beliefs.config.BAN_DURATION);
    }

    recordPosition(x, y) {
        const key = tileKey(x, y);
        this.visits.set(key, (this.visits.get(key) || 0) + 1);
    }

    selectLeastVisited(current_x, current_y, candidateTiles) {
        let selectedTile = null;
        let minVisitCount = Infinity;
        let minDistance = Infinity;

        for (const tile of candidateTiles) {
            const key = tileKey(tile.x, tile.y);
            if (this.bans.isBanned(key)) continue;

            const visitCount = this.visits.get(key) || 0;
            const distance = this.pathfinding.heuristic(current_x, current_y, tile.x, tile.y);

            const isBetter = visitCount < minVisitCount || (visitCount === minVisitCount && distance < minDistance);

            if (isBetter) {
                minVisitCount = visitCount;
                minDistance = distance;
                selectedTile = tile;
            }
        }

        return selectedTile;
    }

    getTarget(current_x, current_y) {
        let spawnerTiles = this.beliefs.environment.spawnerTiles;

        // Filter by zone if assigned
        if (this.beliefs.myArea && this.beliefs.myArea.length > 0) {    
            spawnerTiles = spawnerTiles.filter(spawner => 
                this.beliefs.myArea.some(tile => tile.x === spawner.x && tile.y === spawner.y)
            );
            
            if (spawnerTiles.length === 0) {
                console.log("[Explore] No spawners in my zone, exploring all");
                spawnerTiles = this.beliefs.environment.spawnerTiles;
            }
        }

        const spawnerCandidate = this.selectLeastVisited(current_x, current_y, spawnerTiles);
        if (spawnerCandidate) return spawnerCandidate;

        const normalTiles = this.beliefs.environment.normalTiles;
        return this.selectLeastVisited(current_x, current_y, normalTiles);
    }

    getAction() {
        this.bans.incrementTime();

        const current_x = Math.floor(this.beliefs.x);
        const current_y = Math.floor(this.beliefs.y);

        if (current_x === -1 && current_y === -1) return null;

        this.recordPosition(current_x, current_y);

        if (this.path.length > 0) {
            const move = this.followPath(current_x, current_y);
            if (move) return move;
            else this.clearPath();
        }

        const targetTile = this.getTarget(current_x, current_y);
        if (!targetTile) {
            this.fail("No explorable tiles available");
            return null;
        }

        this.ensurePath(current_x, current_y, targetTile.x, targetTile.y);

        if (this.path.length === 0) {
            console.log(`[Explore] No path to (${targetTile.x}, ${targetTile.y}), banning tile`);
            this.bans.ban(tileKey(targetTile.x, targetTile.y));
            this.fail("No path to exploration target");
            this.clearPath();
            return null;
        }

        return this.followPath(current_x, current_y);
    }
}