import { manhattanDistance, tileKey } from '../Utils/utils.js';

export class Pathfinding {
    constructor(beliefs) {
        this.beliefs = beliefs;
    }

    heuristic(start_x, start_y, target_x, target_y) {
        return manhattanDistance(start_x, start_y, target_x, target_y);
    }

    // A* pathfinding algorithm
    AStar(start_x, start_y, target_x, target_y, options = null) { 
        
        class Node {
            constructor(x, y, g, h, parent) {
                this.x = x;
                this.y = y;
                this.g = g;
                this.h = h;
                this.f = g + h; 
                this.parent = parent;
            }
        }

        const config = options || {};
        const ignoreAgents = !!config.ignoreAgents;

        // Allow path planning "through" specific agents (e.g., partner) and resolve at execution time.
        const ignoreAgentIds = config.ignoreAgentIds instanceof Set ? config.ignoreAgentIds : null;

        const isCellBlocked = (x, y) => {
            if (ignoreAgents) return false;

            const agents = this.beliefs.agents || [];
            for (const agent of agents) {
                if (agent.id === this.beliefs.id) continue;
                if (ignoreAgentIds && ignoreAgentIds.has(agent.id)) continue;

                if (Math.floor(agent.x) === x && Math.floor(agent.y) === y) {
                    return true;
                }
            }
            return false;
        };

        const frontier = [];                 // open set
        const bestInFrontier = new Map();    // key -> best Node currently known for that position
        const explored = new Set();          // closed set

        const startNode = new Node(start_x, start_y, 0, this.heuristic(start_x, start_y, target_x, target_y), null);
        frontier.push(startNode);
        bestInFrontier.set(tileKey(start_x, start_y), startNode);

        while (frontier.length > 0) {
            // Find the node with the lowest total cost in the open set
            let currentNode = frontier[0];
            for (let i = 1; i < frontier.length; i++) {
                if (frontier[i].f < currentNode.f || (frontier[i].f === currentNode.f && frontier[i].h < currentNode.h)) {
                    currentNode = frontier[i];
                }
            }

            // Remove the current node from the open set
            frontier.splice(frontier.indexOf(currentNode), 1);

            // If this is not the best known node for this position anymore, skip it
            const currentKey = tileKey(currentNode.x, currentNode.y);
            if (bestInFrontier.get(currentKey) !== currentNode) continue;
            bestInFrontier.delete(currentKey);

            // If the current node is the target, reconstruct the path
            if (currentNode.x === target_x && currentNode.y === target_y) {
                return this.reconstructPath(currentNode);
            }

            explored.add(currentKey);

            // Get neighbors of the current node
            const neighbors = this.beliefs.environment.map[currentNode.y][currentNode.x].getNeighbors();

            for (const neighbor of neighbors) {
                
                if (isCellBlocked(neighbor.x, neighbor.y)) continue;

                // Skip if already evaluated
                const neighborKey = tileKey(neighbor.x, neighbor.y);
                if (explored.has(neighborKey)) continue;

                const known = bestInFrontier.get(neighborKey);

                if (!known || currentNode.g + 1 < known.g) {
                    const h = this.heuristic(neighbor.x, neighbor.y, target_x, target_y);

                    if (!known) {
                        const next = new Node( neighbor.x, neighbor.y, currentNode.g + 1, h, currentNode);
                        frontier.push(next);
                        bestInFrontier.set(neighborKey, next);
                    } 
                    else {
                        known.g = currentNode.g + 1;
                        known.h = h;
                        known.f = known.g + known.h;
                        known.parent = currentNode;
                    }
                }
            }
        }

        console.log(`A* failed to find a path from (${start_x}, ${start_y}) to (${target_x}, ${target_y})`);
        return [];
    }

    reconstructPath(node) {
        let path = [];
        let temp = node;
        while (temp) {
            path.push( {x: temp.x, y: temp.y} );
            temp = temp.parent;
        }
        return path.reverse().slice(1);
    }

    toAction(x, y, next_x, next_y) {
        const dx = next_x - x;
        const dy = next_y - y;

        if (dx === 1) return 'right';
        else if (dx === -1) return 'left';
        else if (dy === 1) return 'up';
        else if (dy === -1) return 'down';
        else return null;
    }
}